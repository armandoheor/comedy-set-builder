export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.NOTION_TOKEN;

  if (!token) {
    return res.status(500).json({ error: "NOTION_TOKEN is not configured" });
  }

  try {
    const response = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        page_size: 100
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const results = data.results.map(item => ({
      id: item.id,
      object: item.object,
      title:
        item.title?.[0]?.plain_text ||
        item.properties?.title?.title?.[0]?.plain_text ||
        item.properties?.Name?.title?.[0]?.plain_text ||
        "(no title)"
    }));

    return res.status(200).json({
      ok: true,
      results
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
