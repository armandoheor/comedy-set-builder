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
    "Notion-Version": "2025-09-03"
  };

  try {
    // Get the Set
    const setResponse = await fetch(
      `https://api.notion.com/v1/pages/${setId}`,
      { headers }
    );

    const set = await setResponse.json();

    if (!setResponse.ok) {
      return res.status(setResponse.status).json(set);
    }

    // Get the related Bit IDs
    const bitIds = set.properties?.Bits?.relation?.map(item => item.id) || [];

    // Fetch each Bit
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
          id: page.id,
          bit:
            page.properties?.Bit?.title
              ?.map(item => item.plain_text)
              .join("") || "",
          duration: page.properties?.Duration?.number ?? null,
          script:
            page.properties?.Script?.rich_text
              ?.map(item => item.plain_text)
              .join("") || ""
        };
      })
    );

    return res.status(200).json({
      set: set.properties?.Set?.title
        ?.map(item => item.plain_text)
        .join("") || "",
      bits
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
