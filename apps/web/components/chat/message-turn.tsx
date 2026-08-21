"use client"

import * as React from "react"
import { SearchX } from "lucide-react"

import { Avatar } from "@workspace/ui/components/avatar"
import type { AnswerClaim, ChatMessage } from "@/lib/trace-types"
import { ClaimAnswer } from "./claim-answer"
import { EvidencePanel } from "./evidence-panel"
import { MentionText } from "./mention-text"
import { ReasoningPanel } from "./reasoning-panel"
import { StageTicker } from "./stage-ticker"

export function UserTurn({ message, id }: { message: ChatMessage; id?: string }) {
  return (
    // `id` is the anchor the prompt rail scrolls to — see promptAnchorId.
    <div id={id} className="flex justify-end gap-3">
      {/* Uniform inset, not the usual wider-than-tall pair: the mention badges
          inside are inline boxes that can touch any edge, so an even inset is
          what makes their surrounding gap even, and it's the term the badge's
          own radius is derived from (see <MentionText>). */}
      <div className="max-w-[70%] rounded-2xl bg-card p-2.5 text-sm">
        <MentionText text={message.text} />
      </div>
    </div>
  )
}

export function AssistantTurn({
  message,
  onSelectEntity,
  onStop,
  showReasoningByDefault = true,
  showEvidenceByDefault = false,
}: {
  message: ChatMessage
  onSelectEntity?: (mention: string, candidateId: string, label: string) => void
  onStop?: () => void
  showReasoningByDefault?: boolean
  showEvidenceByDefault?: boolean
}) {
  const [activeClaim, setActiveClaim] = React.useState<AnswerClaim | null>(null)
  const result = message.result

  return (
    <div className="flex gap-3">
      <Avatar alt="Graf" size={28} className="mt-0.5 shrink-0 bg-primary/20" />
      <div className="min-w-0 flex-1 space-y-3">
        {message.pending && (
          // Beside the ticker rather than down by the composer: a turn can be
          // started from an entity chip on an older answer, so "the pending
          // one" isn't necessarily the last thing in the thread — the stop has
          // to sit on the turn it stops.
          <div className="flex items-center gap-2">
            <StageTicker />
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
              className="grid size-5 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {/* A square, drawn rather than an icon import, because at this
                  size lucide's Square is a stroked outline where the universal
                  stop glyph is a filled block. */}
              <span aria-hidden className="size-1.5 rounded-[1px] bg-current" />
            </button>
          </div>
        )}

        {result && (
          <>
            {result.notFound ? (
              <p className="flex items-start gap-2 text-[0.9rem] leading-relaxed text-foreground">
                <SearchX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{result.answer}</span>
              </p>
            ) : (
              <ClaimAnswer
                answer={result.answer}
                claims={result.claims}
                activeClaimId={activeClaim?.id}
                onClaimClick={(c) => setActiveClaim((cur) => (cur?.id === c.id ? null : c))}
              />
            )}

            {result.reasoning && <ReasoningPanel reasoning={result.reasoning} defaultExpanded={showReasoningByDefault} />}

            <EvidencePanel
              entityResolutions={result.entityResolutions}
              conflicts={result.conflicts}
              trace={result.trace}
              onSelectEntity={onSelectEntity}
              highlightedNodeIds={activeClaim?.supportingNodeIds ?? null}
              highlightedEdgeIds={activeClaim?.supportingEdgeIds ?? null}
              forceExpand={!!activeClaim}
              defaultExpanded={showEvidenceByDefault}
            />
          </>
        )}
      </div>
    </div>
  )
}
