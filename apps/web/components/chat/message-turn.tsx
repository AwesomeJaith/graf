"use client"

import * as React from "react"
import { motion } from "motion/react"

import { Avatar } from "@workspace/ui/components/avatar"
import type { AnswerClaim, ChatMessage } from "@/lib/trace-types"
import { ClaimAnswer } from "./claim-answer"
import { ConflictCard } from "./conflict-card"
import { EntityResolutionPanel } from "./entity-resolution"
import { GraphTrace } from "../graph/graph-trace"
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
            {result.entityResolutions.length > 0 && (
              <EntityResolutionPanel resolutions={result.entityResolutions} onSelect={onSelectEntity} />
            )}

            {result.reasoning && <ReasoningPanel reasoning={result.reasoning} defaultExpanded={showReasoningByDefault} />}

            {result.notFound ? (
              <p className="text-sm text-muted-foreground italic">{result.answer}</p>
            ) : (
              <ClaimAnswer
                answer={result.answer}
                claims={result.claims}
                activeClaimId={activeClaim?.id}
                onClaimClick={(c) => setActiveClaim((cur) => (cur?.id === c.id ? null : c))}
              />
            )}

            {result.conflicts.map((conflict) => (
              <ConflictCard key={conflict.id} conflict={conflict} />
            ))}

            {result.trace.nodes.length > 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}>
                <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Knowledge trace
                </div>
                <GraphTrace
                  trace={result.trace}
                  highlightedNodeIds={activeClaim?.supportingNodeIds ?? null}
                  highlightedEdgeIds={activeClaim?.supportingEdgeIds ?? null}
                />
              </motion.div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
