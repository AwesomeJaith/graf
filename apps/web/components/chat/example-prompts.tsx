"use client"

import * as React from "react"
import { Tooltip } from "@base-ui/react/tooltip"

/**
 * Verbatim EnterpriseRAG-Bench questions, with the benchmark's own category for
 * each, offered above the composer on an empty thread.
 *
 * Verbatim matters: the point of the demo is that Graf answers the benchmark's
 * questions as written, so a hand-tuned paraphrase would prove nothing. The four
 * here are chosen to be one each of the things a graph does that top-K cosine
 * doesn't — reconcile two sources that disagree, hold a constraint while
 * reading, count exhaustively rather than plausibly, and decline — not because
 * they're the four Graf scores best on.
 *
 * `takeaway` is what to watch in the answer, since none of these are questions a
 * judge can eyeball for correctness against a corpus they haven't read.
 */
const EXAMPLES: { category: string; takeaway: string; question: string }[] = [
  {
    category: "conflicting_info",
    takeaway: "Two sources disagree; the trace shows which one wins and why",
    question:
      "INC-9821: was the degraded GPU node an OOM or intermittent driver/kernel launch stalls?",
  },
  {
    category: "completeness",
    takeaway: "Needs every matching document, not the top few",
    question:
      "In Q4 2025, which customer industry segment was featured in the most published customer stories (case studies + one-page success stories)?",
  },
  {
    category: "constrained",
    takeaway: "Several constraints at once, answered from one specific patch",
    question:
      'In a Private/VPC deployment, some users could complete SAML SSO but then immediately hit 403s because their admin group wasn’t being recognized after an IdP/AD-connector upgrade (early March 2026). What was the underlying parsing problem with the comma-separated "groups" SAML attribute (why the first group didn’t match), and what server-side patch fixed it?',
  },
  {
    category: "info_not_found",
    takeaway: "The corpus doesn’t contain this — the answer should say so",
    question:
      "For the hot-route capacity protection rollout in us-east, which specific enterprise accounts were on the initial allowlist, and what were the exact per-route-group budget values (RPS, estimated TPS, and concurrency) configured for each of those accounts?",
  },
]

/**
 * A blank chat box is a bad first impression for a knowledge assistant: the one
 * thing a new visitor doesn't have is a question this particular corpus can
 * answer, and a wrong guess ("who is my manager?") reads as the system failing
 * rather than as the corpus not containing it.
 *
 * Rendered only on an empty thread — once there's a transcript these would be
 * competing with it for the same space, and the questions are also in the
 * README.
 */
export function ExamplePrompts({ onPick }: { onPick: (question: string) => void }) {
  return (
    <div className="mb-3">
      <p className="mb-2 px-1 text-xs text-muted-foreground">
        Questions from{" "}
        <a
          href="https://github.com/onyx-dot-app/EnterpriseRAG-Bench"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          EnterpriseRAG-Bench
        </a>
        , word for word — click one to run it.
      </p>
      {/* One shared delay group, so moving across the four cards doesn't
          re-wait per card (same reasoning as the prompt rail). */}
      <Tooltip.Provider delay={300}>
        <div className="grid gap-2 sm:grid-cols-2">
          {EXAMPLES.map((example) => (
            <Tooltip.Root key={example.category}>
              <Tooltip.Trigger
                render={
                  <button
                    type="button"
                    onClick={() => onPick(example.question)}
                    className="rounded-lg border border-border bg-card/60 px-3 py-2 text-left transition-colors hover:bg-accent/60"
                  />
                }
              >
                <span className="block font-mono text-[10px] tracking-tight text-muted-foreground">
                  {example.category}
                </span>
                {/* Two lines, because three of these questions are a paragraph
                    long — the full text is in the tooltip, and the takeaway
                    below is what actually tells you why to click it. */}
                <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-foreground">
                  {example.question}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                  {example.takeaway}
                </span>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Positioner side="top" align="start" sideOffset={6}>
                  <Tooltip.Popup className="max-w-md rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] leading-snug text-foreground shadow-md">
                    {example.question}
                  </Tooltip.Popup>
                </Tooltip.Positioner>
              </Tooltip.Portal>
            </Tooltip.Root>
          ))}
        </div>
      </Tooltip.Provider>
    </div>
  )
}
