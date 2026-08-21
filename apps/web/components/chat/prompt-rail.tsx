"use client"

import * as React from "react"
import { PreviewCard } from "@base-ui/react/preview-card"
import { CornerDownLeft } from "lucide-react"

import type { ChatMessage } from "@/lib/trace-types"
import { MentionText, stripMentions } from "./mention-text"

/** The DOM id a user turn is anchored under, so the rail can scroll to it. */
export function promptAnchorId(messageId: string): string {
  return `prompt-${messageId}`
}

/**
 * A row of pills, one per question asked in this conversation, that scroll the
 * transcript back to that question.
 *
 * A long thread is mostly answers — evidence panels and graphs run to several
 * screens each — so scrolling back to "the one where I asked about the pricing
 * doc" means dragging past all of it. The pills are the questions with the
 * answers taken out.
 *
 * Each pill is a hover preview rather than a title attribute: a pill wide
 * enough to hold a whole question would defeat the point of a single row, and a
 * question truncated to a few words is often ambiguous between two turns. The
 * preview shows the question in full, rendered the same way the bubble renders
 * it — mention badges included — so what you hover matches what you'll land on.
 */
export function PromptRail({ messages, onJump }: { messages: ChatMessage[]; onJump: (messageId: string) => void }) {
  const prompts = React.useMemo(() => messages.filter((m) => m.role === "user"), [messages])

  // One question is the one you're looking at; there's nothing to jump back to.
  if (prompts.length < 2) return null

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
      {prompts.map((message, i) => (
        <PreviewCard.Root key={message.id}>
          <PreviewCard.Trigger
            delay={150}
            render={
              <button
                type="button"
                onClick={() => onJump(message.id)}
                aria-label={`Jump to question ${i + 1}`}
                className="flex max-w-[9rem] shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              />
            }
          >
            <span className="text-[9px] tabular-nums text-muted-foreground/60">{i + 1}</span>
            <span className="truncate">{stripMentions(message.text)}</span>
          </PreviewCard.Trigger>
          <PreviewCard.Portal>
            <PreviewCard.Positioner side="bottom" align="start" sideOffset={6}>
              <PreviewCard.Popup className="w-80 rounded-md border border-border bg-card p-3 text-xs shadow-lg outline-none">
                <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">
                  Question {i + 1} of {prompts.length}
                </div>
                {/* Clamped rather than scrolled: this is a preview, and the
                    thing it's previewing is one click away. */}
                <p className="line-clamp-6 leading-relaxed text-foreground">
                  <MentionText text={message.text} />
                </p>
                <div className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <CornerDownLeft className="size-3" />
                  Click to jump here
                </div>
              </PreviewCard.Popup>
            </PreviewCard.Positioner>
          </PreviewCard.Portal>
        </PreviewCard.Root>
      ))}
    </div>
  )
}
