"use client"

import type { AnswerClaim } from "@/lib/trace-types"
import { cn } from "@workspace/ui/lib/utils"
import { Markdown } from "./markdown"

interface ClaimAnswerProps {
  answer: string
  claims: AnswerClaim[]
  activeClaimId?: string | null
  onClaimClick?: (claim: AnswerClaim) => void
}

// Renders the answer with each claim as a clickable span, so clicking a
// sentence can highlight the exact graph path that supports it. Falls back
// to full markdown when there's nothing to make clickable (e.g. "not found").
export function ClaimAnswer({ answer, claims, activeClaimId, onClaimClick }: ClaimAnswerProps) {
  if (claims.length === 0) {
    return <Markdown>{answer}</Markdown>
  }

  const segments: { text: string; claim?: AnswerClaim }[] = []
  let cursor = 0
  for (const claim of claims) {
    const idx = answer.indexOf(claim.text, cursor)
    if (idx === -1) continue
    if (idx > cursor) segments.push({ text: answer.slice(cursor, idx) })
    segments.push({ text: claim.text, claim })
    cursor = idx + claim.text.length
  }
  if (cursor < answer.length) segments.push({ text: answer.slice(cursor) })

  return (
    <p className="text-[0.9rem] leading-relaxed">
      {segments.map((seg, i) =>
        seg.claim ? (
          <span
            key={i}
            role="button"
            tabIndex={0}
            onClick={() => onClaimClick?.(seg.claim!)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onClaimClick?.(seg.claim!)
              }
            }}
            className={cn(
              "rounded-sm px-0.5 -mx-0.5 transition-colors cursor-pointer",
              "hover:bg-primary/15 focus-visible:bg-primary/15 outline-none",
              activeClaimId === seg.claim.id && "bg-primary/20 underline decoration-primary/50"
            )}
          >
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </p>
  )
}
