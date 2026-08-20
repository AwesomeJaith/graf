"use client"

import * as React from "react"
import { ChevronDown, Mail } from "lucide-react"

import { Avatar } from "@workspace/ui/components/avatar"
import { cn } from "@workspace/ui/lib/utils"
import { Markdown } from "../chat/markdown"
import { MetaDot, MetaRow, prop, type NodeProperties } from "./chrome"
import { parseAddress, type EmailMessage } from "./parse"

/** Strips the accumulated Re:/Fwd: prefixes so the thread has one subject line. */
function threadSubject(messages: EmailMessage[], fallback: string): string {
  const raw = messages.find((m) => m.subject)?.subject ?? fallback
  return raw.replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim() || fallback
}

/** "Name <addr>" list → display names, falling back to the address. */
function recipientNames(raw: string): string {
  return raw
    .split(/,(?![^<]*>)/)
    .map((entry) => {
      const { name, address } = parseAddress(entry)
      return name || address
    })
    .filter(Boolean)
    .join(", ")
}

function EmailMessageCard({
  message,
  defaultOpen,
  compact,
}: {
  message: EmailMessage
  defaultOpen: boolean
  compact?: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const sender = parseAddress(message.from)
  const senderName = sender.name || sender.address

  return (
    <div className="bg-card/40">
      {/* The whole header row toggles, the way a mail client's collapsed
          messages do. Everything starts expanded though — this is an evidence
          view, so hiding message bodies behind a click would work against it. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-2.5 text-left transition-colors hover:bg-muted/30",
          compact ? "px-2.5 py-2" : "px-3 py-2.5"
        )}
      >
        <Avatar alt={senderName || "?"} size={compact ? 22 : 28} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[0.8rem] font-semibold">{senderName}</span>
            {message.date && (
              <span className="shrink-0 text-[10px] whitespace-nowrap text-muted-foreground">{message.date}</span>
            )}
          </div>
          {open ? (
            <MetaRow className="mt-0.5">
              {message.to && <span className="truncate">to {recipientNames(message.to)}</span>}
              {message.cc && (
                <>
                  <MetaDot />
                  <span className="truncate">cc {recipientNames(message.cc)}</span>
                </>
              )}
            </MetaRow>
          ) : (
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {message.body.replace(/\s+/g, " ").trim()}
            </div>
          )}
        </div>
        <ChevronDown
          className={cn("mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && message.body && (
        <div className={cn("border-t border-border/30", compact ? "px-2.5 pt-2 pb-2.5" : "px-3 pt-2.5 pb-3")}>
          <Markdown className="text-[0.8rem]">{message.body}</Markdown>
        </div>
      )}
    </div>
  )
}

/**
 * Renders a Gmail node's body as the mail chain it actually is.
 *
 * The node stores the whole thread as one string of RFC-ish header blocks, and
 * in the full corpus the newlines inside each message are escaped, so the
 * default markdown rendering collapsed each email into a single unreadable
 * line with its headers buried in it. parse.ts recovers the messages and their
 * From/To/Cc/Date; this draws them as a thread.
 */
export function EmailThread({
  messages,
  properties,
  subject,
  compact,
}: {
  messages: EmailMessage[]
  properties?: NodeProperties
  subject?: string
  compact?: boolean
}) {
  const displaySubject = threadSubject(messages, subject ?? "Email thread")
  const threadId = prop(properties, "thread_id")

  return (
    <div className="overflow-hidden rounded-md border border-border/70">
      <div className="border-b border-border/70 bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[0.8rem] font-semibold">
          <Mail className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{displaySubject}</span>
        </div>
        <MetaRow className="mt-0.5">
          <span>
            {messages.length} {messages.length === 1 ? "message" : "messages"}
          </span>
          {threadId && (
            <>
              <MetaDot />
              <span className="font-mono text-[10px]">{threadId}</span>
            </>
          )}
        </MetaRow>
      </div>
      <div className="divide-y divide-border/40">
        {messages.map((message, i) => (
          <EmailMessageCard key={i} message={message} defaultOpen compact={compact} />
        ))}
      </div>
    </div>
  )
}
