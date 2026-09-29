export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    return res.status(500).json({ error: "NOTION_TOKEN is not configured" });
  }

  const { setId } = req.query;

  if (!setId) {
    return res.status(400).json({
      error: "Missing setId",
      example: "/api/populate-set?setId=YOUR_SET_PAGE_ID"
    });
  }

  try {
    const response = await fetch(
      `https://api.notion.com/v1/pages/${setId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2025-09-03"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json({
      id: data.id,
      properties: data.properties
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
