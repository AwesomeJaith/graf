import { createConversation, listConversations } from "@/lib/db/conversations"

export async function GET() {
  return Response.json({ conversations: listConversations() })
}

export async function POST() {
  const conversation = createConversation(crypto.randomUUID(), "New chat")
  return Response.json({ conversation })
}
