export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const { setId } = req.query;

  if (!token) {
    return res.status(500).json({ error: "NOTION_TOKEN is not configured" });
  }

  if (!setId) {
    return res.status(400).json({ error: "Missing setId" });
  }

  const response = await fetch(
    `https://api.notion.com/v1/blocks/${setId}/children?page_size=100`,
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

  const blocks = data.results.map(block => ({
    id: block.id,
    type: block.type,
    text:
      block[block.type]?.rich_text
        ?.map(item => item.plain_text)
        .join("") || ""
  }));

  return res.status(200).json(blocks);
}
