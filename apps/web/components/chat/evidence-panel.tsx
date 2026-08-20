"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRight } from "lucide-react"

import type { Conflict, EntityResolution, Trace, TraceNode } from "@/lib/trace-types"
import { cn } from "@workspace/ui/lib/utils"
import { ConflictCard } from "./conflict-card"
import { EntityResolutionPanel } from "./entity-resolution"
import { GraphTrace } from "../graph/graph-trace"

interface EvidencePanelProps {
  entityResolutions: EntityResolution[]
  conflicts: Conflict[]
  trace: Trace
  onSelectEntity?: (mention: string, candidateId: string, label: string) => void
  highlightedNodeIds?: string[] | null
  highlightedEdgeIds?: string[] | null
  onNodeClick?: (node: TraceNode) => void
  /** Expands the panel when a claim is clicked elsewhere, so the highlighted path is visible. */
  forceExpand?: boolean
}

// Bundles everything that backs the answer — entity-resolution confidence,
// detected conflicts, and the knowledge-trace graph — behind one disclosure
// instead of three always-open blocks, so the answer stays the focus and the
// audit trail is one click away.
export function EvidencePanel({
  entityResolutions,
  conflicts,
  trace,
  onSelectEntity,
  highlightedNodeIds,
  highlightedEdgeIds,
  onNodeClick,
  forceExpand,
}: EvidencePanelProps) {
  const [expanded, setExpanded] = React.useState(false)

  React.useEffect(() => {
    if (forceExpand) setExpanded(true)
  }, [forceExpand])

  const hasContent = entityResolutions.length > 0 || conflicts.length > 0 || trace.nodes.length > 0
  if (!hasContent) return null

  const nodeCount = trace.nodes.length
  const summary = [
    nodeCount > 0 ? `${nodeCount} node${nodeCount === 1 ? "" : "s"}` : null,
    conflicts.length > 0 ? `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="rounded-md border border-border/70 bg-card/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ type: "spring", stiffness: 400, damping: 30 }} className="flex">
          <ChevronRight className="size-3.5" />
        </motion.span>
        Evidence
        {summary && <span className="text-muted-foreground/60">· {summary}</span>}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 45 }}
            className="overflow-hidden"
          >
            <div className={cn("space-y-3 px-3 pb-3", (entityResolutions.length > 0 || conflicts.length > 0) && "pt-1")}>
              {entityResolutions.length > 0 && <EntityResolutionPanel resolutions={entityResolutions} onSelect={onSelectEntity} />}
              {conflicts.map((conflict) => (
                <ConflictCard key={conflict.id} conflict={conflict} />
              ))}
              {trace.nodes.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-semibold text-muted-foreground">Knowledge trace</div>
                  <GraphTrace
                    trace={trace}
                    highlightedNodeIds={highlightedNodeIds}
                    highlightedEdgeIds={highlightedEdgeIds}
                    onNodeClick={onNodeClick}
                  />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
