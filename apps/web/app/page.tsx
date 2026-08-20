"use client"

import * as React from "react"

import type { ChatMessage, ChatTurnResult, ResponseMode } from "@/lib/trace-types"
import { useReasoningSetting } from "@/lib/use-reasoning-setting"
import { useConversations } from "@/lib/use-conversations"
import { ChatInput } from "@/components/chat/chat-input"
import { ConversationSidebar } from "@/components/chat/conversation-sidebar"
import { UserTurn, AssistantTurn } from "@/components/chat/message-turn"
import { SettingsMenu } from "@/components/chat/settings-menu"

export default function Page() {
  const { conversations, active, activeId, newChat, selectConversation, deleteConversation, updateMessages } = useConversations()
  const [mode, setMode] = React.useState<ResponseMode>("normal")
  const [showReasoningByDefault, setShowReasoningByDefault] = useReasoningSetting()
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const messages = active?.messages ?? []

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  async function runQuery(
    conversationId: string,
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
      updateMessages(conversationId, (prev) => prev.map((m) => (m.id === pendingId ? { ...m, pending: false, result } : m)))
    } catch (err) {
      updateMessages(conversationId, (prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                ...m,
                pending: false,
                result: {
                  reasoning: "",
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
    if (!activeId) return
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text }
    const pendingId = crypto.randomUUID()
    // Assistant message's `text` doubles as a memo of the question it answered,
    // so re-resolving an entity later can replay the same question.
    updateMessages(activeId, (prev) => [...prev, userMsg, { id: pendingId, role: "assistant", text, pending: true }])
    void runQuery(activeId, text, pendingId)
  }

  function handleSelectEntity(question: string, mention: string, candidateId: string, label: string) {
    if (!activeId) return
    const pendingId = crypto.randomUUID()
    updateMessages(activeId, (prev) => [...prev, { id: pendingId, role: "assistant", text: question, pending: true }])
    void runQuery(activeId, question, pendingId, [{ mention, candidateId: Number(candidateId), label }])
  }

  return (
    <div className="flex h-svh bg-background">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConversation}
        onNewChat={newChat}
        onDelete={deleteConversation}
      />

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end px-5 py-3.5">
          <SettingsMenu showReasoningByDefault={showReasoningByDefault} onShowReasoningByDefaultChange={setShowReasoningByDefault} />
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
                  showReasoningByDefault={showReasoningByDefault}
                />
              )
            )}
          </div>
        </div>

        <div className="px-5 pb-5">
          <div className="mx-auto max-w-3xl">
            <ChatInput mode={mode} onModeChange={setMode} onSubmit={handleSubmit} disabled={!activeId} />
          </div>
        </div>
      </div>
    </div>
  )
}
