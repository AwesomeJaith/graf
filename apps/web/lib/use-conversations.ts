"use client"

import * as React from "react"
import type { ChatMessage } from "./trace-types"

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
}

const TITLE_MAX = 42

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser?.text) return "New chat"
  return firstUser.text.length > TITLE_MAX ? `${firstUser.text.slice(0, TITLE_MAX)}…` : firstUser.text
}

/** Conversations persisted server-side (SQLite, see lib/db) instead of localStorage — survive across devices/browsers, not just one browser's storage. */
export function useConversations() {
  const [conversations, setConversations] = React.useState<Conversation[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const loaded = React.useRef(false)

  React.useEffect(() => {
    ;(async () => {
      const res = await fetch("/api/conversations")
      const data = await res.json()
      let list: Conversation[] = data.conversations ?? []
      if (list.length === 0) {
        const created = await fetch("/api/conversations", { method: "POST" }).then((r) => r.json())
        list = [created.conversation]
      }
      setConversations(list)
      setActiveId(list[0]!.id)
      loaded.current = true
    })()
  }, [])

  const newChat = React.useCallback(async () => {
    const data = await fetch("/api/conversations", { method: "POST" }).then((r) => r.json())
    setConversations((prev) => [data.conversation, ...prev])
    setActiveId(data.conversation.id)
  }, [])

  const selectConversation = React.useCallback((id: string) => setActiveId(id), [])

  const deleteConversation = React.useCallback(
    async (id: string) => {
      void fetch(`/api/conversations/${id}`, { method: "DELETE" })
      const remaining = conversations.filter((c) => c.id !== id)
      if (remaining.length > 0) {
        setConversations(remaining)
        setActiveId((current) => (current === id ? remaining[0]!.id : current))
        return
      }
      const data = await fetch("/api/conversations", { method: "POST" }).then((r) => r.json())
      setConversations([data.conversation])
      setActiveId(data.conversation.id)
    },
    [conversations]
  )

  const updateMessages = React.useCallback((id: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const messages = updater(c.messages)
        const title = deriveTitle(messages)
        void fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, messages }),
        })
        return { ...c, messages, title }
      })
    )
  }, [])

  const active = conversations.find((c) => c.id === activeId) ?? null

  return { conversations, active, activeId, newChat, selectConversation, deleteConversation, updateMessages }
}
