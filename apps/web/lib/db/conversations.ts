import { getDb } from "./client"
import type { ChatMessage } from "../trace-types"

export interface ConversationRow {
  id: string
  title: string
  createdAt: number
  messages: ChatMessage[]
}

interface ConversationTableRow {
  id: string
  title: string
  created_at: number
}

interface MessageTableRow {
  id: string
  role: "user" | "assistant"
  text: string
  pending: number
  result_json: string | null
}

function rowToMessage(row: MessageTableRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    pending: Boolean(row.pending),
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
  }
}

export function listConversations(): ConversationRow[] {
  const db = getDb()
  const conversations = db.prepare("SELECT id, title, created_at FROM conversations ORDER BY created_at DESC").all() as ConversationTableRow[]
  const messagesStmt = db.prepare("SELECT id, role, text, pending, result_json FROM messages WHERE conversation_id = ? ORDER BY position ASC")
  return conversations.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: c.created_at,
    messages: (messagesStmt.all(c.id) as MessageTableRow[]).map(rowToMessage),
  }))
}

export function createConversation(id: string, title: string): ConversationRow {
  const createdAt = Date.now()
  getDb().prepare("INSERT INTO conversations (id, title, created_at) VALUES (?, ?, ?)").run(id, title, createdAt)
  return { id, title, createdAt, messages: [] }
}

export function deleteConversation(id: string): void {
  getDb().prepare("DELETE FROM conversations WHERE id = ?").run(id)
}

export function renameConversation(id: string, title: string): void {
  getDb().prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id)
}

/** Full-replace rather than incremental append — simplest way to keep the stored order/content exactly in sync with what the client has. */
export function replaceMessages(conversationId: string, messages: ChatMessage[]): void {
  const db = getDb()
  const del = db.prepare("DELETE FROM messages WHERE conversation_id = ?")
  const insert = db.prepare(
    "INSERT INTO messages (id, conversation_id, position, role, text, pending, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
  const tx = db.transaction((msgs: ChatMessage[]) => {
    del.run(conversationId)
    msgs.forEach((m, i) => {
      insert.run(m.id, conversationId, i, m.role, m.text, m.pending ? 1 : 0, m.result ? JSON.stringify(m.result) : null)
    })
  })
  tx(messages)
}
