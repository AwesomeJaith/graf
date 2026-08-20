"use client"

import * as React from "react"

import type { ChatMessage, ChatTurnResult, ResponseMode } from "@/lib/trace-types"
import { ChatInput } from "@/components/chat/chat-input"
import { UserTurn, AssistantTurn } from "@/components/chat/message-turn"

export default function Page() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [mode, setMode] = React.useState<ResponseMode>("normal")
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  async function runQuery(
    question: string,
    pendingId: string,
    overrides?: { mention: string; candidateId: number; label: string }[]
  ) {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, mode, overrides }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Request failed")
      const result = data as ChatTurnResult
      setMessages((prev) => prev.map((m) => (m.id === pendingId ? { ...m, pending: false, result } : m)))
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                ...m,
                pending: false,
                result: {
                  answer: err instanceof Error ? err.message : "Something went wrong answering that.",
                  claims: [],
                  trace: { nodes: [], edges: [] },
                  entityResolutions: [],
                  conflicts: [],
                  stages: [],
                  notFound: true,
                },
              }
            : m
        )
      )
    }
  }

  function handleSubmit(text: string) {
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text }
    const pendingId = crypto.randomUUID()
    // Assistant message's `text` doubles as a memo of the question it answered,
    // so re-resolving an entity later can replay the same question.
    setMessages((prev) => [...prev, userMsg, { id: pendingId, role: "assistant", text, pending: true }])
    void runQuery(text, pendingId)
  }

  function handleSelectEntity(question: string, mention: string, candidateId: string, label: string) {
    const pendingId = crypto.randomUUID()
    setMessages((prev) => [...prev, { id: pendingId, role: "assistant", text: question, pending: true }])
    void runQuery(question, pendingId, [{ mention, candidateId: Number(candidateId), label }])
  }

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex items-center justify-between px-5 py-3.5">
        <div className="flex items-center gap-2">
          <div className="size-2 rounded-[3px] bg-primary" />
          <span className="text-sm font-semibold">Graf</span>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 py-4">
          {messages.length === 0 && (
            <div className="flex flex-1 items-center justify-center pt-24 text-sm text-muted-foreground">
              Ask about your organization&apos;s people, projects, and decisions.
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <UserTurn key={m.id} message={m} />
            ) : (
              <AssistantTurn
                key={m.id}
                message={m}
                onSelectEntity={(mention, candidateId, label) => handleSelectEntity(m.text, mention, candidateId, label)}
              />
            )
          )}
        </div>
      </div>

      <div className="px-5 pb-5">
        <div className="mx-auto max-w-3xl">
          <ChatInput mode={mode} onModeChange={setMode} onSubmit={handleSubmit} />
        </div>
      </div>
    </div>
  )
}
