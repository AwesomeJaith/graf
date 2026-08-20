import { searchMentions } from "@workspace/retrieval"

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q") ?? ""
  try {
    const candidates = await searchMentions(query, 8)
    return Response.json({ candidates })
  } catch (err) {
    console.error("mention search failed", err)
    return Response.json({ candidates: [] })
  }
}
