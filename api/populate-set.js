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
        rich_text: [{
          type: "text",
          text: { content: p }
        }]
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
    // Find the SETS data source
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

    // Find a Set requesting population
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
          page_size: 2
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

    if (queryData.results.length > 1) {
      return res.status(409).json({
        error: "More than one Set is marked for population. Uncheck Populate on the extras."
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

    // Find SETLIST heading
    const blocksResponse = await fetch(
      `https://api.notion.com/v1/blocks/${setId}/children?page_size=100`,
      { headers }
    );

    const blocksData = await blocksResponse.json();

    if (!blocksResponse.ok) {
      return res.status(blocksResponse.status).json(blocksData);
    }

    const blocks = blocksData.results;

    const setlistIndex = blocks.findIndex(block => {
      if (block.type !== "heading_2") return false;

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

    // Retrieve Bits
    const bits = await Promise.all(
      bitIds.map(async id => {
        const response = await fetch(
          `https://api.notion.com/v1/pages/${id}`,
          { headers }
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

    // Build toggle blocks
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
          rich_text: [{
            type: "text",
            text: { content: title }
          }],
          children: paragraphs.length
            ? paragraphs
            : [{
                object: "block",
                type: "paragraph",
                paragraph: { rich_text: [] }
              }]
        }
      };
    });

    // Insert immediately after SETLIST
    const writeResponse = await fetch(
      `https://api.notion.com/v1/blocks/${setId}/children`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          children,
          after: blocks[setlistIndex].id
        })
      }
    );

    const writeData = await writeResponse.json();

    if (!writeResponse.ok) {
      return res.status(writeResponse.status).json(writeData);
    }

    // Clear Populate so this Set won't be selected again
    const clearResponse = await fetch(
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

    const clearData = await clearResponse.json();

    if (!clearResponse.ok) {
      return res.status(clearResponse.status).json(clearData);
    }

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
