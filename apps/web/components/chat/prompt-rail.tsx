"use client"

import * as React from "react"
import { Tooltip } from "@base-ui/react/tooltip"

import type { ChatMessage } from "@/lib/trace-types"
import { cn } from "@workspace/ui/lib/utils"
import { stripMentions } from "./mention-text"

/** The DOM id a user turn is anchored under, so the rail can scroll to it. */
export function promptAnchorId(messageId: string): string {
  return `prompt-${messageId}`
}

/**
 * A vertical rail of tick marks pinned to the edge of the transcript, one per
 * question asked, that expands into the questions themselves on hover.
 *
 * A long thread is mostly answers — evidence panels and graphs run to several
 * screens each — so scrolling back to "the one where I asked about the pricing
 * doc" means dragging past all of it. The ticks are the questions with the
 * answers taken out, and they double as a position indicator: the filled one is
 * the question you're currently reading under.
 *
 * Collapsed it's marks rather than text because this sits over the transcript
 * permanently. Anything legible enough to read at rest would compete with the
 * message it's covering, and at one line per question a list of them is taller
 * than the viewport by the time you need it. Expanding on hover is what buys
 * both: no competing text until you reach for it.
 */
export function PromptRail({
  messages,
  activeMessageId,
  onJump,
}: {
  messages: ChatMessage[]
  activeMessageId: string | null
  onJump: (messageId: string) => void
}) {
  const prompts = React.useMemo(() => messages.filter((m) => m.role === "user"), [messages])
  const [expanded, setExpanded] = React.useState(false)

  // One question is the one you're looking at; there's nothing to jump back to.
  if (prompts.length < 2) return null

  return (
    // Hover is tracked on the wrapper, not on either child, so the swap from
    // ticks to list doesn't count as leaving: the list is anchored to the same
    // right edge the cursor is already at, so it opens *under* the pointer.
    <div
      className="absolute top-1/2 right-2 z-20 -translate-y-1/2"
      onPointerEnter={() => setExpanded(true)}
      onPointerLeave={() => setExpanded(false)}
    >
      {expanded ? (
        // `Provider` rather than a per-trigger delay so the rows share one delay
        // group: the first row you rest on waits, and sliding down the list
        // after that shows each tooltip immediately instead of re-waiting per
        // row — which is the difference between reading the list and fighting it.
        <Tooltip.Provider delay={400}>
          <div className="max-h-[70vh] w-[21rem] overflow-y-auto rounded-xl border border-border/70 bg-card/95 p-1.5 shadow-xl backdrop-blur-sm">
            {prompts.map((message) => (
              <Tooltip.Root key={message.id}>
                <Tooltip.Trigger
                  render={
                    <button
                      type="button"
                      onClick={() => {
                        onJump(message.id)
                        setExpanded(false)
                      }}
                      className={cn(
                        "block w-full truncate rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                        message.id === activeMessageId
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                      )}
                    />
                  }
                >
                  {stripMentions(message.text)}
                </Tooltip.Trigger>
                {/* The row truncates at one line, so a long question is exactly
                    the case where you can't tell two turns apart — the tooltip
                    is where the rest of it goes. */}
                <Tooltip.Portal>
                  <Tooltip.Positioner side="bottom" align="start" sideOffset={4}>
                    <Tooltip.Popup className="max-w-sm rounded-md border border-border bg-card px-2 py-1 text-[11px] leading-snug text-foreground shadow-md">
                      {stripMentions(message.text)}
                    </Tooltip.Popup>
                  </Tooltip.Positioner>
                </Tooltip.Portal>
              </Tooltip.Root>
            ))}
          </div>
        </Tooltip.Provider>
      ) : (
        // Padded well past the marks themselves: 3px-tall ticks are a hopeless
        // hover target, and the padding is what makes the rail a strip you can
        // move at rather than a row of hairlines you have to hit.
        <div className="flex flex-col items-end gap-2 py-2 pr-1.5 pl-6">
          {prompts.map((message) => (
            // `rounded-full` on a 3px bar is a 1.5px cap on each end — the whole
            // point of giving the ticks height rather than leaving them
            // hairlines, since a 1px rule has nothing for a radius to round.
            <span
              key={message.id}
              className={cn(
                "h-[3px] rounded-full transition-all",
                message.id === activeMessageId ? "w-7 bg-foreground" : "w-5 bg-muted-foreground/60"
              )}
            />
          ))}
        </div>
      )}
    </div>
  )
}
