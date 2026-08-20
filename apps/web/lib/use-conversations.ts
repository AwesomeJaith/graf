"use client"

import * as React from "react"
import type { ChatMessage } from "./trace-types"

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
}

const STORAGE_KEY = "graf:conversations"
const TITLE_MAX = 42

function makeConversation(): Conversation {
  return { id: crypto.randomUUID(), title: "New chat", messages: [], createdAt: Date.now() }
}

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser?.text) return "New chat"
  return firstUser.text.length > TITLE_MAX ? `${firstUser.text.slice(0, TITLE_MAX)}…` : firstUser.text
}

function loadAll(): Conversation[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Conversations persisted to localStorage — no backend needed for this to survive a refresh or a new tab. */
export function useConversations() {
  const [conversations, setConversations] = React.useState<Conversation[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const hydrated = React.useRef(false)

  React.useEffect(() => {
    const stored = loadAll()
    const initial = stored.length > 0 ? stored : [makeConversation()]
    setConversations(initial)
    setActiveId(initial[0]!.id)
    hydrated.current = true
  }, [])

  React.useEffect(() => {
    if (hydrated.current) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
  }, [conversations])

  const newChat = React.useCallback(() => {
    const fresh = makeConversation()
    setConversations((prev) => [fresh, ...prev])
    setActiveId(fresh.id)
  }, [])

  const selectConversation = React.useCallback((id: string) => setActiveId(id), [])

  const deleteConversation = React.useCallback(
    (id: string) => {
      const remaining = conversations.filter((c) => c.id !== id)
      const next = remaining.length > 0 ? remaining : [makeConversation()]
      setConversations(next)
      setActiveId((current) => (current === id ? next[0]!.id : current))
    },
    [conversations]
  )

  const updateMessages = React.useCallback((id: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const messages = updater(c.messages)
        return { ...c, messages, title: deriveTitle(messages) }
      })
    )
  }, [])

  const active = conversations.find((c) => c.id === activeId) ?? null

  return { conversations, active, activeId, newChat, selectConversation, deleteConversation, updateMessages }
}
