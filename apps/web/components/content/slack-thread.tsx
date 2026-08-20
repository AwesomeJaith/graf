"use client"

import * as React from "react"
import { Hash } from "lucide-react"

import { Avatar } from "@workspace/ui/components/avatar"
import { cn } from "@workspace/ui/lib/utils"
import { Markdown } from "../chat/markdown"
import { MetaDot, MetaRow, formatTimestamp, prop, type NodeProperties } from "./chrome"
import { groupSlackMessages, isBotSpeaker, type SlackMessage } from "./parse"

/**
 * Renders a Slack node's body as the thread it actually is.
 *
 * The node stores one string containing every message in the thread, so the
 * default markdown rendering ran them together and lost who said what — which
 * is exactly the thing you need when checking whether a claim is supported.
 * Consecutive messages from one speaker are grouped under a single avatar, as a
 * chat client does.
 *
 * Speaker avatars reuse the identicon from <Avatar>: it hashes the name to pick
 * its colours, so every participant gets a stable, distinguishable avatar
 * without us storing anything per-person.
 */
export function SlackThread({
  messages,
  properties,
  compact,
}: {
  messages: SlackMessage[]
  properties?: NodeProperties
  compact?: boolean
}) {
  const groups = React.useMemo(() => groupSlackMessages(messages), [messages])
  const speakers = React.useMemo(() => new Set(groups.map((g) => g.speaker).filter(Boolean)), [groups])
  const messageCount = React.useMemo(() => groups.reduce((n, g) => n + g.messages.length, 0), [groups])

  const sentAt = formatTimestamp(prop(properties, "sent_at"))
  const threadId = prop(properties, "thread_id")

  return (
    <div className="overflow-hidden rounded-md border border-border/70">
      {/* Channel bar. The channel name lives on its own Channel node rather
          than on the message, so this identifies the thread by what the node
          does carry — participants, message count and when it started. */}
      <div className="border-b border-border/70 bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[0.8rem] font-semibold">
          <Hash className="size-3.5 text-muted-foreground" />
          <span>Slack thread</span>
        </div>
        <MetaRow className="mt-0.5">
          <span>
            {messageCount} {messageCount === 1 ? "message" : "messages"}
          </span>
          {speakers.size > 0 && (
            <>
              <MetaDot />
              <span>
                {speakers.size} {speakers.size === 1 ? "participant" : "participants"}
              </span>
            </>
          )}
          {sentAt && (
            <>
              <MetaDot />
              <span>{sentAt}</span>
            </>
          )}
          {threadId && (
            <>
              <MetaDot />
              <span className="font-mono text-[10px]">{threadId}</span>
            </>
          )}
        </MetaRow>
      </div>

      <div className="divide-y divide-border/30">
        {groups.map((group, i) => (
          <div key={`${group.speaker}-${i}`} className={cn("flex gap-2.5", compact ? "px-2.5 py-2" : "px-3 py-2.5")}>
            {group.speaker ? (
              <Avatar alt={group.speaker} size={compact ? 22 : 28} className="mt-0.5" />
            ) : (
              <div className="mt-0.5 shrink-0 rounded-[28%] bg-muted" style={{ width: compact ? 22 : 28, height: compact ? 22 : 28 }} />
            )}
            <div className="min-w-0 flex-1">
              {group.speaker && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[0.8rem] font-semibold">{group.speaker}</span>
                  {isBotSpeaker(group.speaker) && (
                    <span className="rounded-sm bg-muted px-1 text-[9px] font-semibold text-muted-foreground">App</span>
                  )}
                </div>
              )}
              {group.messages.map((message, j) => (
                <Markdown key={j} className="mt-0.5 space-y-1.5 text-[0.8rem] leading-snug">
                  {message}
                </Markdown>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
