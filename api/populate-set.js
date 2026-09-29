function formatDuration(minutes) {
  if (minutes == null) return "";

  const totalSeconds = Math.round(minutes * 60);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  return `${mins}:${String(secs).padStart(2, "0")}`;
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
     * 1. Find the SETS data source.
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
     * 2. Find the newest Set where Sync is checked.
     */
    const queryResponse = await fetch(
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

    const queryData = await queryResponse.json();

    if (!queryResponse.ok) {
      return res.status(queryResponse.status).json(queryData);
    }

    if (queryData.results.length === 0) {
      return res.status(400).json({
        error: "No Set is marked for Sync."
      });
    }

    const set = queryData.results[0];
    const setId = set.id;

    const setName =
      set.properties?.Set?.title
        ?.map(item => item.plain_text)
        .join("") || "Set";

    const bitIds =
      set.properties?.Bits?.relation
        ?.map(item => item.id) || [];

    if (!bitIds.length) {
      return res.status(400).json({
        error: `${setName} has no related Bits.`
      });
    }

    /*
     * 3. Read the existing Bit Map.
     */
    const bitMapText =
      set.properties?.["Bit Map"]?.rich_text
        ?.map(item => item.plain_text)
        .join("") || "";

    let bitMap = {};

    if (bitMapText) {
      try {
        bitMap = JSON.parse(bitMapText);
      } catch {
        return res.status(400).json({
          error: "Bit Map contains invalid JSON."
        });
      }
    }

    /*
     * Only Bits that are not already mapped need to be added.
     */
    const missingBitIds = bitIds.filter(id => !bitMap[id]);

    /*
     * 4. Find SETLIST.
     */
    const blocksResponse = await fetch(
      `https://api.notion.com/v1/blocks/${setId}/children?page_size=100`,
      {
        headers
      }
    );

    const blocksData = await blocksResponse.json();

    if (!blocksResponse.ok) {
      return res.status(blocksResponse.status).json(blocksData);
    }

    const blocks = blocksData.results;

    const setlistIndex = blocks.findIndex(block => {
      if (block.type !== "heading_2") {
        return false;
      }

      const text =
        block.heading_2?.rich_text
          ?.map(item => item.plain_text)
          .join("") || "";

      return text.trim().toUpperCase() === "SETLIST";
    });

    if (setlistIndex === -1) {
      return res.status(400).json({
        error: "Could not find the SETLIST heading."
      });
    }

    const setlistBlock = blocks[setlistIndex];

    /*
     * 5. Retrieve ONLY Bits that aren't already mapped.
     */
    const newBits = await Promise.all(
      missingBitIds.map(async id => {
        const response = await fetch(
          `https://api.notion.com/v1/pages/${id}`,
          {
            headers
          }
        );

        const page = await response.json();

        if (!response.ok) {
          throw new Error(`Could not retrieve Bit ${id}`);
        }

        return {
          id,

          bit:
            page.properties?.Bit?.title
              ?.map(item => item.plain_text)
              .join("") || "Untitled Bit",

          duration:
            page.properties?.Duration?.number ?? null,

          script:
            page.properties?.Script?.rich_text
              ?.map(item => item.plain_text)
              .join("") || ""
        };
      })
    );

    /*
     * 6. Create toggles for ONLY the new Bits.
     */
    if (newBits.length > 0) {
      const children = newBits.map(bit => {
        const duration = formatDuration(bit.duration);

        const title = duration
          ? `${bit.bit} — ${duration}`
          : bit.bit;

        const paragraphs = scriptToParagraphs(bit.script);

        return {
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
            children: paragraphs.length
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
      });

      const writeResponse = await fetch(
        `https://api.notion.com/v1/blocks/${setId}/children`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            children,
            after: setlistBlock.id
          })
        }
      );

      const writeData = await writeResponse.json();

      if (!writeResponse.ok) {
        return res.status(writeResponse.status).json(writeData);
      }

      /*
       * Re-read the Set after creating the toggles so we can get
       * the actual top-level toggle block IDs.
       */
      const refreshedResponse = await fetch(
        `https://api.notion.com/v1/blocks/${setId}/children?page_size=100`,
        {
          headers
        }
      );
      
      const refreshedData = await refreshedResponse.json();
      
      if (!refreshedResponse.ok) {
        return res.status(refreshedResponse.status).json(refreshedData);
      }
      
      /*
       * Because the new toggles were inserted immediately after SETLIST,
       * take the first N toggle blocks after SETLIST.
       */
      const refreshedBlocks = refreshedData.results;
      
      const refreshedSetlistIndex = refreshedBlocks.findIndex(
        block => block.id === setlistBlock.id
      );
      
      const createdToggles = refreshedBlocks
        .slice(refreshedSetlistIndex + 1)
        .filter(block => block.type === "toggle")
        .slice(0, newBits.length);
      
      if (createdToggles.length !== newBits.length) {
        return res.status(500).json({
          error:
            "Setlist was created, but the new toggle block IDs could not be identified."
        });
      }
      
      newBits.forEach((bit, index) => {
        bitMap[bit.id] = createdToggles[index].id;
      });
    }

    /*
     * 7. Calculate Duration from ALL related Bits.
     *
     * Existing mapped Bits must also be retrieved for this because Duration
     * represents the complete Set, not only newly added Bits.
     */
    const allBits = await Promise.all(
      bitIds.map(async id => {
        const response = await fetch(
          `https://api.notion.com/v1/pages/${id}`,
          {
            headers
          }
        );

        const page = await response.json();

        if (!response.ok) {
          throw new Error(`Could not retrieve Bit ${id}`);
        }

        return {
          id,

          bit:
            page.properties?.Bit?.title
              ?.map(item => item.plain_text)
              .join("") || "Untitled Bit",

          duration:
            page.properties?.Duration?.number ?? null
        };
      })
    );

    const totalDuration = allBits.reduce(
      (total, bit) => total + (bit.duration || 0),
      0
    );

    /*
     * 8. Save Bit Map + Duration + clear Sync
     * in ONE Set update.
     */
    const metadataResponse = await fetch(
      `https://api.notion.com/v1/pages/${setId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            "Bit Map": {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: JSON.stringify(bitMap)
                  }
                }
              ]
            },

            Duration: {
              number: totalDuration
            },

            Sync: {
              checkbox: false
            }
          }
        })
      }
    );

    const metadataData = await metadataResponse.json();

    if (!metadataResponse.ok) {
      return res.status(metadataResponse.status).json(metadataData);
    }

    /*
     * 9. Report mapped Bits that are no longer related to the Set.
     *
     * Do NOT delete them or their toggles.
     */
    const removedBitIds =
      Object.keys(bitMap).filter(id => !bitIds.includes(id));

    /*
     * 10. Success.
     */
    return res.status(200).json({
      ok: true,
      set: setName,

      message:
        newBits.length > 0
          ? `Added ${newBits.length} Bit${newBits.length === 1 ? "" : "s"} to the Set.`
          : "Setlist is already in sync.",

      added: newBits.map(bit => bit.bit),

      mapped: Object.keys(bitMap).length,

      warnings:
        removedBitIds.length > 0
          ? [
              `${removedBitIds.length} mapped Bit${
                removedBitIds.length === 1 ? "" : "s"
              } are no longer in the Set's Bits relation. Their setlist entries were left untouched.`
            ]
          : []
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
