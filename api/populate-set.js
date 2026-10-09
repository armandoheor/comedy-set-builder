function formatDuration(minutes) {
  if (minutes == null) return "";

  const totalSeconds = Math.round(minutes * 60);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function parseToggleDuration(text) {
  const match = (text || "").match(
    /\s+—\s+(\d+):(\d{1,2})(?=\s|$)/
  );

  if (!match) return null;

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);

  if (seconds >= 60) return null;

  return minutes + seconds / 60;
}

function scriptToParagraphs(script) {
  if (!script) return [];

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

function textToRichTextChunks(text, chunkSize = 2000) {
  const chunks = [];

  for (
    let i = 0;
    i < text.length;
    i += chunkSize
  ) {
    chunks.push({
      type: "text",
      text: {
        content: text.slice(
          i,
          i + chunkSize
        )
      }
    });
  }

  return chunks;
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
    const setsSearchResponse = await fetch(
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

    const setsSearchData =
      await setsSearchResponse.json();

    if (!setsSearchResponse.ok) {
      return res
        .status(setsSearchResponse.status)
        .json(setsSearchData);
    }

    const setsDataSource =
      setsSearchData.results.find(item => {
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
     * 2. Find newest Set where Sync = true.
     */
    const setQueryResponse = await fetch(
      `https://api.notion.com/v1/data_sources/${setsDataSource.id}/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: {
            property: "Sync",
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

    const setQueryData =
      await setQueryResponse.json();

    if (!setQueryResponse.ok) {
      return res
        .status(setQueryResponse.status)
        .json(setQueryData);
    }

    if (!setQueryData.results.length) {
      return res.status(400).json({
        error: "No Set is marked for Sync."
      });
    }

    const set = setQueryData.results[0];
    const setId = set.id;

    const setName =
      set.properties?.Set?.title
        ?.map(item => item.plain_text)
        .join("") || "Set";

    const existingBitIds =
      set.properties?.Bits?.relation
        ?.map(item => item.id) || [];

    /*
     * 3. Find BITS.
     */
    const bitsSearchResponse = await fetch(
      "https://api.notion.com/v1/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: "BITS",
          filter: {
            property: "object",
            value: "data_source"
          }
        })
      }
    );

    const bitsSearchData =
      await bitsSearchResponse.json();

    if (!bitsSearchResponse.ok) {
      return res
        .status(bitsSearchResponse.status)
        .json(bitsSearchData);
    }

    const bitsDataSource =
      bitsSearchData.results.find(item => {
        const title =
          item.title
            ?.map(t => t.plain_text)
            .join("") || "";

        return title === "BITS";
      });

    if (!bitsDataSource) {
      return res.status(404).json({
        error: "Could not find BITS."
      });
    }

    /*
     * 4. Find every Bit where Select = true.
     */
    const selectedResponse = await fetch(
      `https://api.notion.com/v1/data_sources/${bitsDataSource.id}/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: {
            property: "Select",
            checkbox: {
              equals: true
            }
          },

          page_size: 100
        })
      }
    );

    const selectedData =
      await selectedResponse.json();

    if (!selectedResponse.ok) {
      return res
        .status(selectedResponse.status)
        .json(selectedData);
    }

    const selectedBitIds =
      selectedData.results.map(
        item => item.id
      );

    /*
     * 5. Read existing Bit Map.
     */
    const bitMapText =
      set.properties?.["Bit Map"]?.rich_text
        ?.map(item => item.plain_text)
        .join("") || "";

    let bitMap = {};

    if (bitMapText) {
      try {
        bitMap =
          JSON.parse(bitMapText);
      } catch {
        return res.status(400).json({
          error:
            "Bit Map contains invalid JSON."
        });
      }
    }

    /*
     * Reconcile mapped Bits against their
     * actual setlist toggles.
     *
     * If a mapped toggle was manually deleted,
     * that Bit has been removed from the Set.
     */
    const removedBitIds = [];
    
    for (const [bitId, toggleId] of Object.entries(bitMap)) {
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
        removedBitIds.push(bitId);
        delete bitMap[bitId];
      }
    }

    /*
     * Build the Set membership after reconciling
     * manually deleted setlist toggles.
     *
     * A selected Bit is always allowed back in,
     * even if its previous mapped toggle was deleted.
     */
    const bitIds = [
      ...new Set([
        ...existingBitIds.filter(
          id => !removedBitIds.includes(id)
        ),
        ...selectedBitIds
      ])
    ];

    /*
     * Only Bits without a mapping need
     * a new setlist toggle.
     */
    const missingBitIds =
      bitIds.filter(id => !bitMap[id]);

    /*
     * 6. Find SETLIST.
     */
    const blocksResponse = await fetch(
      `https://api.notion.com/v1/blocks/${setId}/children?page_size=100`,
      {
        headers
      }
    );

    const blocksData =
      await blocksResponse.json();

    if (!blocksResponse.ok) {
      return res
        .status(blocksResponse.status)
        .json(blocksData);
    }

    const blocks =
      blocksData.results;

    const setlistIndex =
      blocks.findIndex(block => {
        if (block.type !== "heading_2") {
          return false;
        }

        const text =
          block.heading_2?.rich_text
            ?.map(item => item.plain_text)
            .join("") || "";

        return (
          text.trim().toUpperCase() ===
          "SETLIST"
        );
      });

    if (setlistIndex === -1) {
      return res.status(400).json({
        error:
          "Could not find the SETLIST heading."
      });
    }

    const setlistBlock =
      blocks[setlistIndex];

    /*
     * 7. Retrieve only Bits that need
     * new toggles.
     */
    const newBits =
      await Promise.all(
        missingBitIds.map(async id => {
          const response = await fetch(
            `https://api.notion.com/v1/pages/${id}`,
            {
              headers
            }
          );

          const page =
            await response.json();

          if (!response.ok) {
            throw new Error(
              `Could not retrieve Bit ${id}`
            );
          }

          return {
            id,

            bit:
              page.properties?.Bit?.title
                ?.map(
                  item =>
                    item.plain_text
                )
                .join("") ||
              "Untitled Bit",

            duration:
              page.properties
                ?.Duration?.number ??
              null,

            script:
              page.properties
                ?.Script?.rich_text
                ?.map(
                  item =>
                    item.plain_text
                )
                .join("") || ""
          };
        })
      );

    /*
     * 8. Create each missing Bit toggle
     * individually.
     *
     * This is intentionally NOT batched.
     * We use the exact block ID returned
     * by Notion for each Bit.
     */
    if (newBits.length > 0) {
      let insertAfterId =
        setlistBlock.id;

      for (const bit of newBits) {
        const duration =
          formatDuration(bit.duration);

        const title =
          duration
            ? `${bit.bit} — ${duration}`
            : bit.bit;

        const paragraphs =
          scriptToParagraphs(
            bit.script
          );

        const toggleBlock = {
          object: "block",
          type: "toggle",

          toggle: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: title
                }
              }
            ],

            children:
              paragraphs.length
                ? paragraphs
                : [
                    {
                      object: "block",
                      type: "paragraph",

                      paragraph: {
                        rich_text: []
                      }
                    }
                  ]
          }
        };

        const writeResponse =
          await fetch(
            `https://api.notion.com/v1/blocks/${setId}/children`,
            {
              method: "PATCH",
              headers,

              body: JSON.stringify({
                children: [
                  toggleBlock
                ],

                after:
                  insertAfterId
              })
            }
          );

        const writeData =
          await writeResponse.json();

        if (!writeResponse.ok) {
          return res
            .status(
              writeResponse.status
            )
            .json(writeData);
        }

        const createdToggle =
          writeData.results?.[0];

        if (
          !createdToggle ||
          createdToggle.type !==
            "toggle" ||
          !createdToggle.id
        ) {
          return res
            .status(500)
            .json({
              error:
                `Created setlist entry for "${bit.bit}", but Notion did not return its toggle block ID.`
            });
        }

        /*
         * Exact Bit -> toggle mapping.
         */
        bitMap[bit.id] =
          createdToggle.id;

        /*
         * Next new Bit goes after this
         * newly-created Bit.
         */
        insertAfterId =
          createdToggle.id;
      }
    }

    /*
     * 9. Calculate Duration from the actual
     * surviving setlist toggles.
     */
    let totalSeconds = 0;
    
    for (const bitId of bitIds) {
      const toggleId = bitMap[bitId];
    
      if (!toggleId) {
        throw new Error(
          `No setlist toggle mapped for Bit ${bitId}`
        );
      }
    
      const response = await fetch(
        `https://api.notion.com/v1/blocks/${toggleId}`,
        { headers }
      );
    
      const toggle = await response.json();
    
      if (!response.ok) {
        throw new Error(
          `Could not retrieve toggle ${toggleId}`
        );
      }
    
      if (
        toggle.archived ||
        toggle.in_trash ||
        toggle.type !== "toggle"
      ) {
        throw new Error(
          `Invalid setlist toggle ${toggleId}`
        );
      }
    
      const title =
        (toggle.toggle?.rich_text || [])
          .map(item => item.plain_text || "")
          .join("");
    
      const duration = parseToggleDuration(title);

      if (duration !== null) {
        totalSeconds += Math.round(duration * 60);
      }
    }
    
    const totalDuration = totalSeconds / 60;

    /*
     * 10. Save:
     *
     * - merged Bits relation
     * - Bit Map
     * - Duration
     *
     * Do NOT clear Sync yet.
     */
    const metadataResponse =
      await fetch(
        `https://api.notion.com/v1/pages/${setId}`,
        {
          method: "PATCH",
          headers,

          body: JSON.stringify({
            properties: {
              Bits: {
                relation:
                  bitIds.map(id => ({
                    id
                  }))
              },

              "Bit Map": {
                rich_text:
                  textToRichTextChunks(
                    JSON.stringify(bitMap)
                  )
              },

              Duration: {
                number:
                  totalDuration
              }
            }
          })
        }
      );

    const metadataData =
      await metadataResponse.json();

    if (!metadataResponse.ok) {
      return res
        .status(
          metadataResponse.status
        )
        .json(metadataData);
    }

    /*
     * 11. Set update succeeded.
     *
     * Clear Select on every Bit that
     * participated in this Sync.
     */
    for (
      const selectedBitId of
      selectedBitIds
    ) {
      const clearSelectResponse =
        await fetch(
          `https://api.notion.com/v1/pages/${selectedBitId}`,
          {
            method: "PATCH",
            headers,

            body: JSON.stringify({
              properties: {
                Select: {
                  checkbox: false
                }
              }
            })
          }
        );

      const clearSelectData =
        await clearSelectResponse.json();

      if (!clearSelectResponse.ok) {
        return res
          .status(
            clearSelectResponse.status
          )
          .json({
            error:
              `Set was synced, but Select could not be cleared for Bit ${selectedBitId}.`,

            notion:
              clearSelectData,

            partial_update: true
          });
      }
    }

    /*
     * 12. Everything succeeded.
     *
     * Clear Sync LAST.
     */
    const clearSyncResponse =
      await fetch(
        `https://api.notion.com/v1/pages/${setId}`,
        {
          method: "PATCH",
          headers,

          body: JSON.stringify({
            properties: {
              Sync: {
                checkbox: false
              }
            }
          })
        }
      );

    const clearSyncData =
      await clearSyncResponse.json();

    if (!clearSyncResponse.ok) {
      return res
        .status(
          clearSyncResponse.status
        )
        .json({
          error:
            "Set was synced and selected Bits were cleared, but the Set's Sync checkbox could not be cleared.",

          notion:
            clearSyncData,

          partial_update: true
        });
    }

    /*
     * 13. Success.
     */
    return res
      .status(200)
      .json({
        ok: true,

        set:
          setName,

        message:
          newBits.length > 0 || removedBitIds.length > 0
            ? `Synced Setlist: added ${newBits.length}, removed ${removedBitIds.length}.`
            : "Setlist is already in sync.",

        selected_added_to_relation:
          selectedBitIds.filter(
            id =>
              !existingBitIds.includes(
                id
              )
          ).length,

        added:
          newBits.map(
            bit => bit.bit
          ),

        removed:
          removedBitIds.length,

        mapped:
          Object.keys(bitMap)
            .length
      });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
