export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.NOTION_TOKEN) {
    return res.status(500).json({ error: "NOTION_TOKEN is not configured" });
  }

  return res.status(200).json({
    ok: true,
    message: "Comedy Set Builder is running"
  });
}
