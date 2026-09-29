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
     * 2. Find the newest Set where Populate is checked.
     */
    const queryResponse = await fetch(
      `https://api.notion.com/v1/data_sources/${setsDataSource.id}/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: {
            property: "Populate",
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
        error: "No Set is marked for population."
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
     * 3. Find the SETLIST heading in the Set page.
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

    // Find the divider that ends the SETLIST section
    const dividerIndex = blocks.findIndex(
      (block, index) =>
        index > setlistIndex &&
        block.type === "divider"
    );
    
    if (dividerIndex === -1) {
      return res.status(400).json({
        error: "Could not find the divider after SETLIST."
      });
    }
    
    // Check whether SETLIST already contains anything
    const existingSetlistBlocks = blocks.slice(
      setlistIndex + 1,
      dividerIndex
    );
    
    // Ignore the Populate Set button itself
    const existingContent = existingSetlistBlocks.filter(
      block => block.type !== "button"
    );
    
    if (existingContent.length > 0) {
    // Clear Populate on this Set before returning
    await fetch(
      `https://api.notion.com/v1/pages/${setId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            Populate: {
              checkbox: false
            }
          }
        })
      }
    );
  
    return res.status(409).json({
      error: "This Set already has a populated SETLIST."
    });
  }

    /*
     * 4. Retrieve every related Bit.
     */
    const bits = await Promise.all(
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

    const totalDuration = bits.reduce(
      (total, bit) => total + (bit.duration || 0),
      0
    );

    /*
     * 5. Convert the Bits into real Notion toggle blocks.
     */
    const children = bits.map(bit => {
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

    /*
     * 6. Insert the toggles immediately after SETLIST.
     */
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
     * 7. Find ALL Sets where Populate is still checked.
     */
    const pendingResponse = await fetch(
      `https://api.notion.com/v1/data_sources/${setsDataSource.id}/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filter: {
            property: "Populate",
            checkbox: {
              equals: true
            }
          },
          page_size: 100
        })
      }
    );

    const pendingData = await pendingResponse.json();

    if (!pendingResponse.ok) {
      return res.status(pendingResponse.status).json(pendingData);
    }

    // Update Set metadata
    const metadataResponse = await fetch(
      `https://api.notion.com/v1/pages/${setId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            "Total Duration": {
              number: totalDuration
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
     * 8. Clear Populate on all of those Sets.
     */
    const clearResponses = await Promise.all(
      pendingData.results.map(page =>
        fetch(
          `https://api.notion.com/v1/pages/${page.id}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              properties: {
                Populate: {
                  checkbox: false
                }
              }
            })
          }
        )
      )
    );

    /*
     * Make sure every checkbox update succeeded.
     */
    for (const response of clearResponses) {
      if (!response.ok) {
        const errorData = await response.json();

        return res.status(response.status).json({
          error: "Set was populated, but a Populate checkbox could not be cleared.",
          notion: errorData
        });
      }
    }

    /*
     * 9. Success.
     */
    return res.status(200).json({
      ok: true,
      set: setName,
      message: `Populated ${bits.length} Bits.`,
      bits: bits.map(bit => bit.bit)
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
