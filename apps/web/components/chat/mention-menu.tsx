"use client"

import { NodeIcon } from "../graph/node-icon"
import type { MentionCandidate } from "./chat-input"

export function MentionMenu({
  candidates,
  activeIndex,
  loading,
  onSelect,
}: {
  candidates: MentionCandidate[]
  activeIndex: number
  loading: boolean
  onSelect: (candidate: MentionCandidate) => void
}) {
  return (
    <div className="absolute inset-x-0 bottom-full mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-card p-1.5 shadow-lg">
      {loading && candidates.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">Searching…</div>}
      {!loading && candidates.length === 0 && (
        <div className="px-2.5 py-2 text-xs text-muted-foreground">No matches — keep typing to narrow it down.</div>
      )}
      {candidates.map((c, i) => (
        <button
          key={c.id}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(c)
          }}
          className={cnRow(i === activeIndex)}
        >
          <NodeIcon kind={c.label} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{c.name}</span>
          {c.subtitle && <span className="truncate text-muted-foreground">{c.subtitle}</span>}
          <span className="ml-auto shrink-0 text-[10px] tracking-wide text-muted-foreground/70 uppercase">{c.label}</span>
        </button>
      ))}
    </div>
  )
}

function cnRow(active: boolean) {
  return [
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
    active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  ].join(" ")
}
