"use client"

import { AlertTriangle, Check } from "lucide-react"

import type { Conflict } from "@/lib/trace-types"
import { cn } from "@workspace/ui/lib/utils"

export function ConflictCard({ conflict }: { conflict: Conflict }) {
  return (
    <div className="rounded-md border border-primary/25 bg-primary/[0.04] p-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-primary">
        <AlertTriangle className="size-3.5" />
        Conflicting information found — {conflict.subject}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {conflict.candidates.map((c) => {
          const selected = c.nodeId === conflict.selectedNodeId
          return (
            <div
              key={c.nodeId}
              className={cn(
                "min-w-36 flex-1 rounded-md border px-2.5 py-2 text-xs",
                selected ? "border-primary/40 bg-card" : "border-border/70 bg-card/60 opacity-70"
              )}
            >
              <div className="text-muted-foreground">{c.timestamp}</div>
              <div className="mt-0.5 font-medium">{c.value}</div>
              <div className="mt-1 flex items-center justify-between text-muted-foreground">
                <span>{c.source}</span>
                {selected && (
                  <span className="flex items-center gap-1 text-primary">
                    <Check className="size-3" /> Selected
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{conflict.rationale}</p>
    </div>
  )
}
