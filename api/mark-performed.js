function richTextToPlain(richText) {
  return (richText || [])
    .map(item => item.plain_text || "")
    .join("");
}

function normalizeScript(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function parseToggleTitle(text) {
  const value = (text || "").trim();

  /*
   * Expected:
   * TITLE — 2:30
   *
   * Duration is optional so a Bit without a duration still works.
   */
  const match = value.match(/^(.*?)(?:\s+—\s+(\d+):(\d{1,2}))?$/);

  if (!match) {
    return null;
  }

  const title = match[1].trim();

  if (!title) {
    return null;
  }

  let duration = null;

  if (match[2] != null) {
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);

    if (
      !Number.isFinite(minutes) ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds >= 60
    ) {
      return null;
    }

    duration = minutes + seconds / 60;
  }

  return {
    title,
    duration
  };
}

async function getAllBlockChildren(blockId, headers) {
  const results = [];
  let cursor = null;

  do {
    const url = new URL(
      `https://api.notion.com/v1/blocks/${blockId}/children`
    );

    url.searchParams.set("page_size", "100");

    if (cursor) {
      url.searchParams.set("start_cursor", cursor);
    }

    const response = await fetch(url, {
      headers
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `Could not retrieve children for block ${blockId}: ` +
        JSON.stringify(data)
      );
    }

    results.push(...data.results);

    cursor = data.has_more
      ? data.next_cursor
      : null;

  } while (cursor);

  return results;
}

function blocksToScript(blocks) {
  /*
   * For now we expect the scripts created by Sync Setlist:
   * paragraph blocks containing plain text.
   *
   * Blank paragraphs are preserved as paragraph separators.
   */
  return blocks
    .filter(block => block.type === "paragraph")
    .map(block =>
      richTextToPlain(block.paragraph?.rich_text)
    )
    .join("\n\n")
    .trim();
}

function formatDuration(minutes) {
  if (minutes == null) return "";

  const totalSeconds = Math.round(minutes * 60);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatVersionDate(dateString) {
  if (!dateString) return "Unknown date";

  const [year, month, day] = dateString.split("-").map(Number);

  const date = new Date(Date.UTC(year, month - 1, day));

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

function scriptToParagraphBlocks(script) {
  if (!script) {
    return [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: []
        }
      }
    ];
  }

  return script
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: p
            }
          }
        ]
      }
    }));
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    return res.status(500).json({
      error: "NOTION_TOKEN is not configured"
    });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2025-09-03",
    "Content-Type": "application/json"
  };

  try {
    /*
     * 1. Find SETS.
     */
    const searchResponse = await fetch(
      "https://api.notion.com/v1/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: "SETS",
          filter: {
            property: "object",
            value: "data_source"
          }
        })
      }
    );

    const searchData = await searchResponse.json();

    if (!searchResponse.ok) {
      return res.status(searchResponse.status).json(searchData);
    }

    const setsDataSource = searchData.results.find(item => {
      const title =
        item.title?.map(t => t.plain_text).join("") || "";

      return title === "SETS";
    });

    if (!setsDataSource) {
      return res.status(404).json({
        error: "Could not find SETS."
      });
    }

    /*
     * 2. Find newest Set marked Performed.
     */
    const queryResponse = await fetch(
      `https://api.notion.com/v1/data_sources/${setsDataSource.id}/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: {
            property: "Performed",
            checkbox: {
              equals: true
            }
          },
          sorts: [
            {
              timestamp: "created_time",
              direction: "descending"
            }
          ],
          page_size: 1
        })
      }
    );

    const queryData = await queryResponse.json();

    if (!queryResponse.ok) {
      return res.status(queryResponse.status).json(queryData);
    }

    if (!queryData.results.length) {
      return res.status(400).json({
        error: "No Set is marked Performed."
      });
    }

    const set = queryData.results[0];
    const setId = set.id;

    const setName =
      richTextToPlain(set.properties?.Set?.title) ||
      "Untitled Set";

    const setDate =
      set.properties?.Date?.date?.start || null;

    if (!setDate) {
      return res.status(400).json({
        error: `${setName} has no Date.`
      });
    }

    /*
     * 3. Read Bit Map.
     */
    const bitMapText =
      richTextToPlain(
        set.properties?.["Bit Map"]?.rich_text
      );

    if (!bitMapText) {
      return res.status(400).json({
        error: `${setName} has no Bit Map. Sync the Set first.`
      });
    }

    let bitMap;

    try {
      bitMap = JSON.parse(bitMapText);
    } catch {
      return res.status(400).json({
        error: "Bit Map contains invalid JSON."
      });
    }

    const mappings = Object.entries(bitMap);

    if (!mappings.length) {
      return res.status(400).json({
        error: "Bit Map is empty."
      });
    }

    /*
     * 4. Validate relation against Bit Map.
     */
    const relatedBitIds =
      set.properties?.Bits?.relation
        ?.map(item => item.id) || [];

    const mappedBitIds = Object.keys(bitMap);

    const unmappedRelatedBits =
      relatedBitIds.filter(id => !bitMap[id]);

    const mappedButUnrelatedBits =
      mappedBitIds.filter(
        id => !relatedBitIds.includes(id)
      );

    if (
      unmappedRelatedBits.length ||
      mappedButUnrelatedBits.length
    ) {
      return res.status(409).json({
        error:
          "Set relation and Bit Map are not in sync. Run Sync Setlist before marking the Set performed.",

        related_without_mapping:
          unmappedRelatedBits,

        mapped_without_relation:
          mappedButUnrelatedBits,

        dry_run: true
      });
    }

    /*
     * 5. Inspect every mapped Bit + toggle.
     *
     * Nothing is modified.
     */
    const report = await Promise.all(
      mappings.map(async ([bitId, toggleId]) => {
        /*
         * Retrieve canonical Bit.
         */
        const bitResponse = await fetch(
          `https://api.notion.com/v1/pages/${bitId}`,
          {
            headers
          }
        );

        const bitPage = await bitResponse.json();

        if (!bitResponse.ok) {
          throw new Error(
            `Could not retrieve mapped Bit ${bitId}`
          );
        }

        /*
         * Retrieve mapped toggle itself.
         */
        const toggleResponse = await fetch(
          `https://api.notion.com/v1/blocks/${toggleId}`,
          {
            headers
          }
        );

        const toggle = await toggleResponse.json();

        if (!toggleResponse.ok) {
          throw new Error(
            `Could not retrieve mapped toggle ${toggleId}`
          );
        }

        if (toggle.archived || toggle.in_trash) {
          throw new Error(
            `Mapped toggle ${toggleId} has been deleted.`
          );
        }

        if (toggle.type !== "toggle") {
          throw new Error(
            `Mapped block ${toggleId} is no longer a toggle.`
          );
        }

        const toggleTitle =
          richTextToPlain(toggle.toggle?.rich_text);

        const parsed =
          parseToggleTitle(toggleTitle);

        if (!parsed) {
          throw new Error(
            `Could not parse setlist title: "${toggleTitle}"`
          );
        }

        /*
         * Read the current contents of the working Set toggle.
         */
        const toggleChildren =
          await getAllBlockChildren(
            toggleId,
            headers
          );

        const performedScript =
          blocksToScript(toggleChildren);

        /*
         * Current canonical Bit values.
         */
        const currentTitle =
          richTextToPlain(
            bitPage.properties?.Bit?.title
          );

        const currentDuration =
          bitPage.properties?.Duration?.number ??
          null;

        const currentScript =
          richTextToPlain(
            bitPage.properties?.Script?.rich_text
          );

        const lastPerformed =
          bitPage.properties?.["Last Performed"]
            ?.date?.start || null;

        const lastPerformedSet =
          bitPage.properties?.["Last Performed Set"]
            ?.relation?.[0]?.id || null;

        /*
         * Compare.
         */
        const titleChanged =
          currentTitle !== parsed.title;

        const durationChanged =
          currentDuration !== parsed.duration;

        const scriptChanged =
          normalizeScript(currentScript) !==
          normalizeScript(performedScript);

        const contentChanged =
          titleChanged ||
          durationChanged ||
          scriptChanged;

        return {
          bit_id: bitId,
          toggle_id: toggleId,

          current: {
            title: currentTitle,
            duration: currentDuration,
            script: currentScript,
            last_performed: lastPerformed,
            last_performed_set:
              lastPerformedSet
          },

          performed: {
            title: parsed.title,
            duration: parsed.duration,
            script: performedScript,
            date: setDate,
            set_id: setId
          },

          changes: {
            title: titleChanged,
            duration: durationChanged,
            script: scriptChanged
          },

          would_create_version:
            contentChanged,

          would_update_bit: true
        };
      })
    );

    /*
     * 6. VERSION WRITE TEST
     *
     * Creates historical versions for changed Bits.
     * DOES NOT update the canonical Bit.
     */
    const versionsCreated = [];
    
    for (const item of report) {
      if (!item.would_create_version) {
        continue;
      }
    
      const bitId = item.bit_id;
    
      /*
       * Get the Bit page's top-level blocks and find VERSIONS.
       */
      const bitBlocks = await getAllBlockChildren(
        bitId,
        headers
      );
    
      const versionsBlock = bitBlocks.find(block => {
        if (
          block.type !== "heading_1" &&
          block.type !== "heading_2" &&
          block.type !== "heading_3" &&
          block.type !== "toggle"
        ) {
          return false;
        }
    
        const richText =
          block[block.type]?.rich_text || [];
    
        return (
          richTextToPlain(richText)
            .trim()
            .toUpperCase() === "VERSIONS"
        );
      });
    
      if (!versionsBlock) {
        return res.status(400).json({
          error:
            `Could not find VERSIONS on Bit "${item.current.title}".`,
          dry_run: false
        });
      }
    
      /*
       * Read existing versions.
       */
      const existingVersions =
        await getAllBlockChildren(
          versionsBlock.id,
          headers
        );
    
      /*
       * Determine highest existing vN.
       */
      let highestVersion = 0;
    
      for (const block of existingVersions) {
        if (block.type !== "toggle") {
          continue;
        }
    
        const text =
          richTextToPlain(
            block.toggle?.rich_text
          ).trim();
    
        const match = text.match(/^v(\d+)\b/i);
    
        if (match) {
          highestVersion = Math.max(
            highestVersion,
            Number(match[1])
          );
        }
      }
    
      const nextVersion =
        highestVersion + 1;
    
      /*
       * Resolve the OLD Last Performed Set name.
       */
      let oldSetName = null;
    
      if (item.current.last_performed_set) {
        const oldSetResponse = await fetch(
          `https://api.notion.com/v1/pages/${item.current.last_performed_set}`,
          {
            headers
          }
        );
    
        const oldSetPage =
          await oldSetResponse.json();
    
        if (oldSetResponse.ok) {
          oldSetName =
            richTextToPlain(
              oldSetPage.properties?.Set?.title
            ) || null;
        }
      }
    
      /*
       * Build compact version title.
       */
      const titleParts = [
        `v${nextVersion}`,
        formatVersionDate(
          item.current.last_performed
        )
      ];
    
      if (oldSetName) {
        titleParts.push(oldSetName);
      }
    
      /*
       * Include OLD title only if title changed.
       */
      if (item.changes.title) {
        titleParts.push(
          item.current.title || "Untitled Bit"
        );
      }
    
      /*
       * Include OLD duration only if duration changed.
       */
      if (item.changes.duration) {
        const oldDuration =
          formatDuration(
            item.current.duration
          );
    
        if (oldDuration) {
          titleParts.push(oldDuration);
        }
      }
    
      const versionTitle =
        titleParts.join(" — ");
    
      /*
       * Build the new version toggle.
       */
      const versionBlock = {
        object: "block",
        type: "toggle",
        toggle: {
          rich_text: [
            {
              type: "text",
              text: {
                content: versionTitle
              }
            }
          ],
    
          children:
            scriptToParagraphBlocks(
              item.current.script
            )
        }
      };
    
      /*
       * Insert newest version at the TOP of VERSIONS.
       *
       * If existing versions exist, append normally first.
       * We'll verify visual ordering in this test before
       * making the final production implementation.
       */
      const versionResponse = await fetch(
        `https://api.notion.com/v1/blocks/${versionsBlock.id}/children`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            children: [versionBlock]
          })
        }
      );
    
      const versionData =
        await versionResponse.json();
    
      if (!versionResponse.ok) {
        return res
          .status(versionResponse.status)
          .json(versionData);
      }
    
      versionsCreated.push({
        bit: item.current.title,
        version: versionTitle
      });
    }

    /*
     * 6. Summary.
     */
    const changedBits =
      report.filter(
        item => item.would_create_version
      );

    return res.status(200).json({
      ok: true,
      dry_run: true,

      set: {
        id: setId,
        name: setName,
        date: setDate
      },

      summary: {
        bits_checked: report.length,
        bits_with_content_changes:
          changedBits.length,
        versions_to_create:
          changedBits.length
      },

      bits: report,

      versions_created: versionsCreated,

      message:
        "VERSION WRITE TEST — historical versions were created, but canonical Bits were NOT updated."
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message,
      dry_run: true
    });
  }
}
