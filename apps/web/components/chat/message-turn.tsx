"use client"

import * as React from "react"
import { SearchX } from "lucide-react"

import { Avatar } from "@workspace/ui/components/avatar"
import type { AnswerClaim, ChatMessage } from "@/lib/trace-types"
import { ClaimAnswer } from "./claim-answer"
import { EvidencePanel } from "./evidence-panel"
import { ReasoningPanel } from "./reasoning-panel"
import { StageTicker } from "./stage-ticker"

export function UserTurn({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end gap-3">
      <div className="max-w-[70%] rounded-xl bg-card px-3.5 py-2.5 text-sm">{message.text}</div>
    </div>
  )
}

export function AssistantTurn({
  message,
  onSelectEntity,
  showReasoningByDefault = true,
}: {
  message: ChatMessage
  onSelectEntity?: (mention: string, candidateId: string, label: string) => void
  showReasoningByDefault?: boolean
}) {
  const [activeClaim, setActiveClaim] = React.useState<AnswerClaim | null>(null)
  const result = message.result

  return (
    <div className="flex gap-3">
      <Avatar alt="Graf" size={28} className="mt-0.5 shrink-0 bg-primary/20" />
      <div className="min-w-0 flex-1 space-y-3">
        {message.pending && <StageTicker />}

        {result && (
          <>
            {result.reasoning && <ReasoningPanel reasoning={result.reasoning} defaultExpanded={showReasoningByDefault} />}

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

            <EvidencePanel
              entityResolutions={result.entityResolutions}
              conflicts={result.conflicts}
              trace={result.trace}
              onSelectEntity={onSelectEntity}
              highlightedNodeIds={activeClaim?.supportingNodeIds ?? null}
              highlightedEdgeIds={activeClaim?.supportingEdgeIds ?? null}
              forceExpand={!!activeClaim}
            />
          </>
        )}
      </div>
    </div>
  )
}
