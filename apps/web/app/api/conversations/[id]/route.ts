import { deleteConversation, renameConversation, replaceMessages } from "@/lib/db/conversations"
import type { ChatMessage } from "@/lib/trace-types"

interface PatchBody {
  title?: string
  messages?: ChatMessage[]
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body: PatchBody = await request.json()
  if (typeof body.title === "string") renameConversation(id, body.title)
  if (Array.isArray(body.messages)) replaceMessages(id, body.messages)
  return Response.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  deleteConversation(id)
  return Response.json({ ok: true })
}
