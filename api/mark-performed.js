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

  const match =
    value.match(/^(.*?)(?:\s+—\s+(\d+):(\d{1,2}))?$/);

  if (!match) return null;

  const title = match[1].trim();

  if (!title) return null;

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

  const [year, month, day] =
    dateString.split("-").map(Number);

  const date =
    new Date(Date.UTC(year, month - 1, day));

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

    const searchData =
      await searchResponse.json();

    if (!searchResponse.ok) {
      return res
        .status(searchResponse.status)
        .json(searchData);
    }

    const setsDataSource =
      searchData.results.find(item => {
        const title =
          item.title
            ?.map(t => t.plain_text)
            .join("") || "";

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

    const queryData =
      await queryResponse.json();

    if (!queryResponse.ok) {
      return res
        .status(queryResponse.status)
        .json(queryData);
    }

    if (!queryData.results.length) {
      return res.status(400).json({
        error: "No Set is marked Performed."
      });
    }

    const set = queryData.results[0];
    const setId = set.id;

    const setName =
      richTextToPlain(
        set.properties?.Set?.title
      ) || "Untitled Set";

    const setDate =
      set.properties?.Date?.date?.start ||
      null;

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
        error:
          `${setName} has no Bit Map. Sync the Set first.`
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

    const mappings =
      Object.entries(bitMap);

    if (!mappings.length) {
      return res.status(400).json({
        error: "Bit Map is empty."
      });
    }

    /*
     * 4. Validate Set relation against Bit Map.
     */
    const relatedBitIds =
      set.properties?.Bits?.relation
        ?.map(item => item.id) || [];

    const mappedBitIds =
      Object.keys(bitMap);

    const unmappedRelatedBits =
      relatedBitIds.filter(
        id => !bitMap[id]
      );

    /*
     * 5. READ + VALIDATE EVERYTHING FIRST.
     *
     * No writes occur in this stage.
     */
    const report = await Promise.all(
      mappings.map(
        async ([bitId, toggleId]) => {
          /*
           * Set toggle.
           */
          const toggleResponse = await fetch(
            `https://api.notion.com/v1/blocks/${toggleId}`,
            {
              headers
            }
          );

          const toggle =
            await toggleResponse.json();

          if (!toggleResponse.ok) {
            throw new Error(
              `Could not retrieve mapped toggle ${toggleId}`
            );
          }

          if (
            toggle.archived ||
            toggle.in_trash
          ) {
            return {
              bitId,
              toggleId,
              performed: false
            };
          }

          if (toggle.type !== "toggle") {
            throw new Error(
              `Mapped block ${toggleId} is no longer a toggle.`
            );
          }

          /*
           * Canonical Bit.
           */
          const bitResponse = await fetch(
            `https://api.notion.com/v1/pages/${bitId}`,
            {
              headers
            }
          );

          const bitPage =
            await bitResponse.json();

          if (!bitResponse.ok) {
            throw new Error(
              `Could not retrieve mapped Bit ${bitId}`
            );
          }

          const toggleTitle =
            richTextToPlain(
              toggle.toggle?.rich_text
            );

          const parsed =
            parseToggleTitle(toggleTitle);

          if (!parsed) {
            throw new Error(
              `Could not parse setlist title: "${toggleTitle}"`
            );
          }

          const toggleChildren =
            await getAllBlockChildren(
              toggleId,
              headers
            );

          const performedScript =
            blocksToScript(
              toggleChildren
            );

          /*
           * Canonical values.
           */
          const currentTitle =
            richTextToPlain(
              bitPage.properties?.Bit?.title
            );

          const currentDuration =
            bitPage.properties
              ?.Duration?.number ?? null;

          const currentScript =
            richTextToPlain(
              bitPage.properties
                ?.Script?.rich_text
            );

          const lastPerformed =
            bitPage.properties
              ?.["Last Performed"]
              ?.date?.start || null;

          const lastPerformedSet =
            bitPage.properties
              ?.["Last Performed Set"]
              ?.relation?.[0]?.id || null;

          const titleChanged =
            currentTitle !== parsed.title;

          const durationChanged =
            currentDuration !==
            parsed.duration;

          const scriptChanged =
            normalizeScript(currentScript) !==
            normalizeScript(performedScript);

          const contentChanged =
            titleChanged ||
            durationChanged ||
            scriptChanged;

          /*
           * If a version will be required,
           * validate VERSIONS + anchor NOW,
           * before anything is written.
           */
          let versionInfo = null;

          if (contentChanged) {
            const bitBlocks =
              await getAllBlockChildren(
                bitId,
                headers
              );

            const versionsBlock =
              bitBlocks.find(block => {
                if (
                  block.type !== "heading_1" &&
                  block.type !== "heading_2" &&
                  block.type !== "heading_3" &&
                  block.type !== "toggle"
                ) {
                  return false;
                }

                const richText =
                  block[block.type]
                    ?.rich_text || [];

                return (
                  richTextToPlain(richText)
                    .trim()
                    .toUpperCase() ===
                  "VERSIONS"
                );
              });

            if (!versionsBlock) {
              throw new Error(
                `Could not find VERSIONS on Bit "${currentTitle}".`
              );
            }

            const existingVersions =
              await getAllBlockChildren(
                versionsBlock.id,
                headers
              );

            const versionAnchor =
              existingVersions.find(block => {
                const richText =
                  block[block.type]?.rich_text || [];
            
                const text =
                  richTextToPlain(richText).trim();
            
                return text === "…" || text === "...";
              });
            
            if (!versionAnchor) {
              throw new Error(
                `Could not find the version anchor on Bit "${currentTitle}".`
              );
            }

            let highestVersion = 0;

            for (
              const block of
              existingVersions
            ) {
              if (
                block.type !== "toggle"
              ) {
                continue;
              }

              const text =
                richTextToPlain(
                  block.toggle
                    ?.rich_text
                ).trim();

              const match =
                text.match(
                  /^v(\d+)\b/i
                );

              if (match) {
                highestVersion =
                  Math.max(
                    highestVersion,
                    Number(match[1])
                  );
              }
            }

            versionInfo = {
              versionsBlockId:
                versionsBlock.id,

              anchorId:
                versionAnchor.id,

              nextVersion:
                highestVersion + 1
            };
          }

          return {
            bitId,
            toggleId,

            current: {
              title: currentTitle,
              duration: currentDuration,
              script: currentScript,
              lastPerformed,
              lastPerformedSet
            },

            performed: {
              title: parsed.title,
              duration: parsed.duration,
              script: performedScript
            },

            changes: {
              title: titleChanged,
              duration: durationChanged,
              script: scriptChanged
            },

            contentChanged,
            versionInfo
          };
        }
      )
    );

    /*
     * Everything structural has now been validated.
     *
     * 6. Resolve old Set names needed for
     * version titles.
     */
    for (const item of report) {
      if (
        !item.contentChanged ||
        !item.current.lastPerformedSet
      ) {
        continue;
      }

      const oldSetResponse =
        await fetch(
          `https://api.notion.com/v1/pages/${item.current.lastPerformedSet}`,
          {
            headers
          }
        );

      const oldSetPage =
        await oldSetResponse.json();

      if (oldSetResponse.ok) {
        item.oldSetName =
          richTextToPlain(
            oldSetPage.properties
              ?.Set?.title
          ) || null;
      } else {
        item.oldSetName = null;
      }
    }

    /*
     * 7. WRITE.
     *
     * Only surviving mapped toggles were actually performed.
     */
    const performedReport =
      report.filter(
        item => item.performed !== false
      );
    
    const versionsCreated = [];
    const bitsUpdated = [];
    
    for (const item of performedReport) {
      /*
       * Archive the OLD canonical version
       * if any content changed.
       */
      if (item.contentChanged) {
        const titleParts = [
          `v${item.versionInfo.nextVersion}`,
          formatVersionDate(
            item.current.lastPerformed
          )
        ];

        if (item.oldSetName) {
          titleParts.push(
            item.oldSetName
          );
        }

        /*
         * Add old title only if title changed.
         */
        if (item.changes.title) {
          titleParts.push(
            item.current.title ||
            "Untitled Bit"
          );
        }

        /*
         * Add old duration only if duration changed.
         */
        if (item.changes.duration) {
          const oldDuration =
            formatDuration(
              item.current.duration
            );

          if (oldDuration) {
            titleParts.push(
              oldDuration
            );
          }
        }

        const versionTitle =
          titleParts.join(" — ");

        const versionBlock = {
          object: "block",
          type: "toggle",

          toggle: {
            rich_text: [
              {
                type: "text",
                text: {
                  content:
                    versionTitle
                }
              }
            ],

            children:
              scriptToParagraphBlocks(
                item.current.script
              )
          }
        };

        const versionResponse =
          await fetch(
            `https://api.notion.com/v1/blocks/${item.versionInfo.versionsBlockId}/children`,
            {
              method: "PATCH",
              headers,
              body: JSON.stringify({
                children: [
                  versionBlock
                ],

                after:
                  item.versionInfo
                    .anchorId
              })
            }
          );

        const versionData =
          await versionResponse.json();

        if (!versionResponse.ok) {
          return res
            .status(
              versionResponse.status
            )
            .json({
              error:
                `Could not archive the previous version of "${item.current.title}".`,

              notion:
                versionData,

              partial_update:
                versionsCreated.length >
                0
            });
        }

        versionsCreated.push({
          bit:
            item.current.title,

          version:
            versionTitle
        });
      }

      /*
       * Promote what was actually performed
       * into the canonical Bit.
       *
       * This happens for EVERY Bit, even when
       * content did not change, because performance
       * metadata must still be updated.
       */
      const updateResponse =
        await fetch(
          `https://api.notion.com/v1/pages/${item.bitId}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              properties: {
                Bit: {
                  title: [
                    {
                      type: "text",
                      text: {
                        content:
                          item.performed
                            .title
                      }
                    }
                  ]
                },

                Duration: {
                  number:
                    item.performed
                      .duration
                },

                Script: {
                  rich_text:
                    item.performed.script
                      ? [
                          {
                            type: "text",
                            text: {
                              content:
                                item
                                  .performed
                                  .script
                            }
                          }
                        ]
                      : []
                },

                "Last Performed": {
                  date: {
                    start:
                      setDate
                  }
                },

                "Last Performed Set": {
                  relation: [
                    {
                      id: setId
                    }
                  ]
                }
              }
            })
          }
        );

      const updateData =
        await updateResponse.json();

      if (!updateResponse.ok) {
        return res
          .status(
            updateResponse.status
          )
          .json({
            error:
              `Could not update Bit "${item.current.title}".`,

            notion:
              updateData,

            partial_update: true
          });
      }

      bitsUpdated.push({
        before:
          item.current.title,

        after:
          item.performed.title,

        changes:
          item.changes
      });
    }

    /*
     * 8. Mark operation complete.
     *
     * Clear Performed ONLY after every Bit
     * has been processed successfully.
     */

    const performedTotalDuration =
      performedReport.reduce(
        (total, item) =>
          total + (item.performed.duration || 0),
        0
      );
    
    const performedBitIds =
      performedReport.map(
        item => item.bitId
      );
    
    const clearResponse =
      await fetch(
        `https://api.notion.com/v1/pages/${setId}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            properties: {
              Bits: {
                relation:
                  performedBitIds.map(id => ({
                    id
                  }))
              },
            
              Duration: {
                number: performedTotalDuration
              },
            
              Performed: {
                checkbox: false
              }
            }
          })
        }
      );

    const clearData =
      await clearResponse.json();

    if (!clearResponse.ok) {
      return res
        .status(clearResponse.status)
        .json({
          error:
            "Bits were updated successfully, but the Set's Performed checkbox could not be cleared.",

          notion:
            clearData,

          partial_update: true
        });
    }

    /*
     * 9. Success.
     */
    return res.status(200).json({
      ok: true,

      set: {
        id: setId,
        name: setName,
        date: setDate
      },

      summary: {
        bits_performed:
          performedReport.length,
      
        bits_not_performed:
          report.length - performedReport.length,
      
        bits_with_content_changes:
          performedReport.filter(
            item =>
              item.contentChanged
          ).length,
      
        versions_created:
          versionsCreated.length
      },

      versions_created:
        versionsCreated,

      bits_updated:
        bitsUpdated,

      message:
        `Marked "${setName}" as performed with ${performedReport.length} Bit${performedReport.length === 1 ? "" : "s"}.`
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
