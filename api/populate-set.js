function formatDuration(minutes) {
  if (minutes == null) return "";

  const totalSeconds = Math.round(minutes * 60);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function scriptToParagraphs(script) {
  if (!script) return [];

  // Blank lines separate paragraphs.
  return script
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: paragraph
            }
          }
        ]
      }
    }));
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const { setId } = req.query;

  if (!token) {
    return res.status(500).json({
      error: "NOTION_TOKEN is not configured"
    });
  }

  if (!setId) {
    return res.status(400).json({
      error: "Missing setId"
    });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2025-09-03",
    "Content-Type": "application/json"
  };

  try {
    // 1. Retrieve the Set page
    const setResponse = await fetch(
      `https://api.notion.com/v1/pages/${setId}`,
      { headers }
    );

    const set = await setResponse.json();

    if (!setResponse.ok) {
      return res.status(setResponse.status).json(set);
    }

    // 2. Get its related Bit IDs
    const bitIds =
      set.properties?.Bits?.relation?.map(item => item.id) || [];

    if (bitIds.length === 0) {
      return res.status(400).json({
        error: "This Set has no related Bits."
      });
    }

    // 3. Retrieve each Bit
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

    // 4. Turn each Bit into a real Notion toggle
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

          // Notion requires something inside the toggle.
          children:
            paragraphs.length > 0
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

    // 5. Append the toggles to the Set page
    const writeResponse = await fetch(
      `https://api.notion.com/v1/blocks/${setId}/children`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ children })
      }
    );

    const result = await writeResponse.json();

    if (!writeResponse.ok) {
      return res.status(writeResponse.status).json(result);
    }

    return res.status(200).json({
      ok: true,
      message: `Added ${bits.length} Bits to the Set.`,
      bits: bits.map(bit => bit.bit)
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
