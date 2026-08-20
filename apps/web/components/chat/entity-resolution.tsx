"use client"

import { motion } from "motion/react"
import { Check } from "lucide-react"

import type { EntityResolution } from "@/lib/trace-types"
import { cn } from "@workspace/ui/lib/utils"

interface EntityResolutionPanelProps {
  resolutions: EntityResolution[]
  onSelect?: (mention: string, candidateId: string, label: string) => void
}

// "I found: Sam → Sam Ratnaparkhi 94% / Samuel Chen 4% / Sam Wilson 2%" — the
// semantic-reference-resolution step made visible and, when ambiguous,
// interactive.
export function EntityResolutionPanel({ resolutions, onSelect }: EntityResolutionPanelProps) {
  if (resolutions.length === 0) return null

  return (
    <div className="flex flex-wrap gap-3">
      {resolutions.map((res) => {
        const top = res.candidates[0]
        const ambiguous = res.candidates.length > 1 && (top?.confidence ?? 1) < 0.85
        return (
          <div key={res.mention} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>&ldquo;{res.mention}&rdquo;</span>
              {!ambiguous && <Check className="size-3 text-primary" />}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {res.candidates.map((c) => {
                const selected = res.resolvedId === c.id
                return (
                  <motion.button
                    key={c.id}
                    type="button"
                    layout
                    onClick={() => onSelect?.(res.mention, c.id, c.type)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                      selected
                        ? "border-primary/40 bg-primary/15 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  >
                    <span className="max-w-56 truncate font-medium">{c.name}</span>
                    <span className="shrink-0 tabular-nums opacity-70">{Math.round(c.confidence * 100)}%</span>
                  </motion.button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
