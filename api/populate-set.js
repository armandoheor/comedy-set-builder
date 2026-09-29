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
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{
          type: "text",
          text: { content: paragraph }
        }]
      }
    }));
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const { setId } = req.query;

  if (!token) {
    return res.status(500).json({ error: "NOTION_TOKEN is not configured" });
  }

  if (!setId) {
    return res.status(400).json({ error: "Missing setId" });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2025-09-03",
    "Content-Type": "application/json"
  };

  try {
    // Get Set page
    const setResponse = await fetch(
      `https://api.notion.com/v1/pages/${setId}`,
      { headers }
    );

    const set = await setResponse.json();

    if (!setResponse.ok) {
      return res.status(setResponse.status).json(set);
    }

    const bitIds =
      set.properties?.Bits?.relation?.map(item => item.id) || [];

    if (!bitIds.length) {
      return res.status(400).json({
        error: "This Set has no related Bits."
      });
    }

    // Find the divider immediately following SETLIST
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

    const divider = blocks
      .slice(setlistIndex + 1)
      .find(block => block.type === "divider");

    if (!divider) {
      return res.status(400).json({
        error: "Could not find the divider after SETLIST."
      });
    }

    // Retrieve related Bits
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

    // Build toggles
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

    // Insert immediately before the divider
    const writeResponse = await fetch(
      `https://api.notion.com/v1/blocks/${setId}/children`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          children,
          insert_before: divider.id
        })
      }
    );

    const result = await writeResponse.json();

    if (!writeResponse.ok) {
      return res.status(writeResponse.status).json(result);
    }

    return res.status(200).json({
      ok: true,
      message: `Added ${bits.length} Bits under SETLIST.`,
      bits: bits.map(bit => bit.bit)
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
