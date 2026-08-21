"use client"

import * as React from "react"

import { terminalResult, type ChatMessage, type ChatTurnResult, type ResponseMode } from "@/lib/trace-types"
import { useEvidenceSetting, useReasoningSetting } from "@/lib/use-panel-defaults"
import { useConversations } from "@/lib/use-conversations"
import { ChatInput } from "@/components/chat/chat-input"
import { ConversationSidebar } from "@/components/chat/conversation-sidebar"
import { UserTurn, AssistantTurn } from "@/components/chat/message-turn"
import { PromptRail, promptAnchorId } from "@/components/chat/prompt-rail"
import { SettingsMenu } from "@/components/chat/settings-menu"

/**
 * Gap left above a jumped-to question, in px. Matches the `pt-14` on the
 * message list: land the question where the first message sits, i.e. clear of
 * the fade rather than under it.
 */
const JUMP_CLEARANCE = 56

export default function Page() {
  const { conversations, active, activeId, newChat, selectConversation, deleteConversation, updateMessages } = useConversations()
  const [mode, setMode] = React.useState<ResponseMode>("normal")
  const [showReasoningByDefault, setShowReasoningByDefault] = useReasoningSetting()
  const [showEvidenceByDefault, setShowEvidenceByDefault] = useEvidenceSetting()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // Keyed by pending message id rather than held as one "current request",
  // because a turn is startable from an entity chip on an *older* answer — so
  // several can legitimately be in flight, and stop has to hit the right one.
  const abortersRef = React.useRef(new Map<string, AbortController>())

  // Memoised so the fallback isn't a fresh array identity every render: two
  // effects below key off `messages`, and one of them subscribes to scroll —
  // without this it would tear down and re-attach that listener continuously.
  const messages = React.useMemo(() => active?.messages ?? [], [active])
  const [activePromptId, setActivePromptId] = React.useState<string | null>(null)

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  // Which question the rail fills in: the last one scrolled past the top fade,
  // i.e. the one whose answer you're reading. Measured on scroll rather than
  // with an IntersectionObserver because the interesting line is a fixed offset
  // into the container, not a share of the element being visible — a question
  // whose answer runs several screens long stays current the whole way down,
  // and its own bubble is long gone off the top by then.
  React.useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = container.getBoundingClientRect().top
      let current: string | null = null
      for (const m of messages) {
        if (m.role !== "user") continue
        const el = document.getElementById(promptAnchorId(m.id))
        if (!el) continue
        if (el.getBoundingClientRect().top - top > JUMP_CLEARANCE + 1) break
        current = m.id
      }
      // Nothing scrolled past yet means we're at the top, on the first question.
      setActivePromptId(current ?? messages.find((m) => m.role === "user")?.id ?? null)
    }
    const onScroll = () => {
      // Coalesced to one measurement per frame: this reads layout for every
      // question in the thread, and scroll fires far more often than that.
      if (!frame) frame = requestAnimationFrame(update)
    }
    container.addEventListener("scroll", onScroll)
    update()
    return () => {
      container.removeEventListener("scroll", onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [messages])

  // Measured against the container's own rect rather than `offsetTop`, which
  // would be relative to whichever ancestor happens to be positioned.
  function jumpToPrompt(messageId: string) {
    const container = scrollRef.current
    const target = document.getElementById(promptAnchorId(messageId))
    if (!container || !target) return
    // Set directly rather than waiting for the scroll to report it: a short
    // thread, or a question already at the clearance line, scrolls nowhere at
    // all — no scroll event, so the rail would sit unmoved on a click that did
    // land. Anything that does scroll re-derives this a frame later anyway.
    setActivePromptId(messageId)
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTo({ top: Math.max(0, container.scrollTop + delta - JUMP_CLEARANCE), behavior: "smooth" })
  }

  async function runQuery(
    conversationId: string,
    question: string,
    pendingId: string,
    overrides?: { mention: string; candidateId: number; label: string }[]
  ) {
    const aborter = new AbortController()
    abortersRef.current.set(pendingId, aborter)
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, mode, overrides }),
        signal: aborter.signal,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Request failed")
      const result = data as ChatTurnResult
      updateMessages(conversationId, (prev) => prev.map((m) => (m.id === pendingId ? { ...m, pending: false, result } : m)))
    } catch (err) {
      // A cancel lands here too — `fetch` rejects on abort — but it isn't an
      // error, so it says so plainly instead of surfacing "The user aborted a
      // request." from the platform. Either way the turn stops being pending:
      // a spinner with nothing behind it is the one outcome to avoid.
      const cancelled = err instanceof Error && err.name === "AbortError"
      const answer = cancelled
        ? "Cancelled."
        : err instanceof Error
          ? err.message
          : "Something went wrong answering that."
      updateMessages(conversationId, (prev) =>
        prev.map((m) => (m.id === pendingId ? { ...m, pending: false, result: terminalResult(answer) } : m))
      )
    } finally {
      abortersRef.current.delete(pendingId)
    }
  }

  function stopTurn(pendingId: string) {
    abortersRef.current.get(pendingId)?.abort()
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
          <SettingsMenu
            showReasoningByDefault={showReasoningByDefault}
            onShowReasoningByDefaultChange={setShowReasoningByDefault}
            showEvidenceByDefault={showEvidenceByDefault}
            onShowEvidenceByDefaultChange={setShowEvidenceByDefault}
          />
        </header>

        {/* `min-h-0` so the scroller, not this wrapper, is what overflows: a
            flex child's implicit min-height is its content unless the overflow
            is its own, and the wrapper's has to stay visible to hold the fade. */}
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} className="h-full overflow-y-auto px-5">
            {/* `pt-14` clears the h-12 fade below, so the first message can be
                scrolled fully clear of it rather than sitting under the blur at
                the top of the scroll range. */}
            <div className="mx-auto flex max-w-3xl flex-col gap-6 pt-14 pb-4">
              {messages.length === 0 && (
                <div className="flex flex-1 items-center justify-center pt-24 text-sm text-muted-foreground">
                  Ask about your organization&apos;s people, projects, and decisions.
                </div>
              )}
              {messages.map((m) =>
                m.role === "user" ? (
                  <UserTurn key={m.id} message={m} id={promptAnchorId(m.id)} />
                ) : (
                  <AssistantTurn
                    key={m.id}
                    message={m}
                    onSelectEntity={(mention, candidateId, label) => handleSelectEntity(m.text, mention, candidateId, label)}
                    onStop={() => stopTurn(m.id)}
                    showReasoningByDefault={showReasoningByDefault}
                    showEvidenceByDefault={showEvidenceByDefault}
                  />
                )
              )}
            </div>
          </div>
          {/* Softens the top edge, where messages otherwise get sliced off
              mid-glyph by the scroll box. A gradient alone would only fade the
              text out; the mask is what makes the blur itself fade, since
              `backdrop-filter` takes no gradient of its own — masking the layer
              masks what it blurred. Pointer-events off so it can't eat clicks
              on the message it's sitting over. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-background to-transparent backdrop-blur-[3px] [mask-image:linear-gradient(to_bottom,black_35%,transparent)]"
          />
          {/* Overlays the transcript at its right edge, and lives in this
              wrapper rather than the header so it centres on the scroller it
              indexes — a header-mounted rail would be a column of ticks with no
              relationship to where they point. */}
          <PromptRail messages={messages} activeMessageId={activePromptId} onJump={jumpToPrompt} />
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
