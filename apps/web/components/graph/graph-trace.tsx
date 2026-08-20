"use client"

import * as React from "react"
import { motion } from "motion/react"
import { Dialog } from "@base-ui/react/dialog"

import { FileText, X } from "lucide-react"

import type { Trace, TraceNode } from "@/lib/trace-types"
import { cn } from "@workspace/ui/lib/utils"
import { ContentView } from "../content/content-view"
import { NodeIcon } from "./node-icon"

/** How much of a node's body the inspector previews before deferring to the viewer. */
const PREVIEW_MAX_HEIGHT = 200

interface GraphTraceProps {
  trace: Trace
  highlightedNodeIds?: string[] | null
  highlightedEdgeIds?: string[] | null
  onNodeClick?: (node: TraceNode) => void
}

interface EdgePath {
  id: string
  d: string
  midX: number
  midY: number
  label: string
  active: boolean
  showLabel: boolean
}

/**
 * Grid size, in px, for thinning out edge labels. A column pair joined by a
 * dozen `AUTHORED` edges puts a dozen identical pills at almost the same
 * midpoint, which stacks into an illegible blob — one label per cell keeps the
 * relationship type readable without claiming to annotate every edge.
 */
const LABEL_CELL = 34

// Groups nodes into columns by hop-distance from the resolved entities, then
// measures the real rendered DOM positions to draw connecting edges. The
// layout is derived entirely from `trace` — there is no separate mock graph,
// so whatever the retrieval pipeline actually touched is what renders here.
export function GraphTrace({ trace, highlightedNodeIds, highlightedEdgeIds, onNodeClick }: GraphTraceProps) {
  const columns = React.useMemo(() => layoutColumns(trace), [trace])
  const containerRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const inspectorRef = React.useRef<HTMLDivElement>(null)
  const nodeRefs = React.useRef(new Map<string, HTMLDivElement>())
  const [edgePaths, setEdgePaths] = React.useState<EdgePath[]>([])
  const [inspected, setInspected] = React.useState<TraceNode | null>(null)
  const [viewingNode, setViewingNode] = React.useState<TraceNode | null>(null)

  // The inspector panel opens below the graph, possibly off-screen — bring it
  // (not the whole chat) into view, and only scroll as far as needed.
  React.useEffect(() => {
    if (!inspected) return
    inspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [inspected])

  const measure = React.useCallback(() => {
    // Measured against the content wrapper, not the scroll container: the
    // wrapper grows to the full width/height of the columns, so these
    // coordinates stay valid when the graph is panned. Using the container's
    // rect made every coordinate relative to the *visible* box instead.
    const content = contentRef.current
    if (!content) return
    const origin = content.getBoundingClientRect()
    const paths: EdgePath[] = []

    for (const edge of trace.edges) {
      const from = nodeRefs.current.get(edge.from)
      const to = nodeRefs.current.get(edge.to)
      if (!from || !to) continue
      const fr = from.getBoundingClientRect()
      const tr = to.getBoundingClientRect()

      // Which sides to join. Always leaving the right edge and arriving at the
      // left assumes the target sits in a later column, and an edge pointing
      // back at an earlier one then had to double back across its own source
      // card — the tangle of hairpins in the top-left of the graph. Pick the
      // facing sides instead, and join vertically when the two share a column.
      const forwardGap = tr.left - fr.right
      const backwardGap = fr.left - tr.right
      let x1: number, y1: number, x2: number, y2: number, d: string

      if (forwardGap > 8 || backwardGap > 8) {
        const forward = forwardGap > 8
        x1 = (forward ? fr.right : fr.left) - origin.left
        x2 = (forward ? tr.left : tr.right) - origin.left
        y1 = fr.top + fr.height / 2 - origin.top
        y2 = tr.top + tr.height / 2 - origin.top
        const midX = (x1 + x2) / 2
        d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
      } else {
        const downward = tr.top >= fr.top
        x1 = fr.left + fr.width / 2 - origin.left
        x2 = tr.left + tr.width / 2 - origin.left
        y1 = (downward ? fr.bottom : fr.top) - origin.top
        y2 = (downward ? tr.top : tr.bottom) - origin.top
        const midY = (y1 + y2) / 2
        d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
      }

      paths.push({
        id: edge.id,
        d,
        // Both curve forms above are symmetric, so the point at t=0.5 is exactly
        // the average of the endpoints — the label sits on the line, not near it.
        midX: (x1 + x2) / 2,
        midY: (y1 + y2) / 2,
        label: edge.type.replace(/_/g, " ").toLowerCase(),
        active: !highlightedEdgeIds || highlightedEdgeIds.includes(edge.id),
        showLabel: false,
      })
    }

    // Thin the labels down to one per grid cell, letting highlighted edges
    // claim their cell first so a label is never spent on a dimmed edge while
    // the edge the answer actually cites goes unlabelled.
    const taken = new Set<string>()
    for (const path of [...paths].sort((a, b) => Number(b.active) - Number(a.active))) {
      const cell = `${Math.round(path.midX / LABEL_CELL)}:${Math.round(path.midY / LABEL_CELL)}`
      if (taken.has(cell)) continue
      taken.add(cell)
      path.showLabel = true
    }

    setEdgePaths(paths)
  }, [trace, highlightedEdgeIds])

  React.useLayoutEffect(() => {
    measure()
    // Both boxes matter: the container changes when the panel resizes, and the
    // content wrapper when the columns themselves reflow (which moves every
    // endpoint without the container changing size at all).
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    if (contentRef.current) ro.observe(contentRef.current)
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [measure])

  const dimmed = (id: string) => !!highlightedNodeIds && !highlightedNodeIds.includes(id)

  // Pan-to-scroll: drag the background (not a node) to reveal nodes that
  // spread beyond the panel instead of relying on scrollbars alone.
  const panState = React.useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null)
  const [panning, setPanning] = React.useState(false)

  const onBackgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-node-card]")) return
    const container = containerRef.current
    if (!container) return
    panState.current = { x: e.clientX, y: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop }
    setPanning(true)
    e.preventDefault()
  }

  React.useEffect(() => {
    if (!panning) return
    function onMove(e: PointerEvent) {
      const container = containerRef.current
      const start = panState.current
      if (!container || !start) return
      container.scrollLeft = start.scrollLeft - (e.clientX - start.x)
      container.scrollTop = start.scrollTop - (e.clientY - start.y)
    }
    function onUp() {
      panState.current = null
      setPanning(false)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [panning])

  return (
    <div className="rounded-lg border border-border/70 bg-card/40">
      <div
        ref={containerRef}
        onPointerDown={onBackgroundPointerDown}
        className={cn("relative max-h-[30rem] overflow-auto p-6", panning ? "cursor-grabbing" : "cursor-grab")}
      >
        {/* The edge layer lives inside the content wrapper rather than the
            scroll container. An `inset-0 h-full w-full` SVG resolves against
            its containing block, so anchored to the scroll container it was
            only ever as large as the *visible* box — and since an SVG clips its
            children, every path outside that box disappeared the moment the
            graph was panned, leaving the label pills (plain divs, unclipped)
            floating with no lines attached to them. */}
        <div ref={contentRef} className="relative flex items-start gap-32">
          <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            {edgePaths.map((p) => (
              <motion.path
                key={p.id}
                d={p.d}
                fill="none"
                stroke={p.active ? "var(--color-primary)" : "var(--color-border)"}
                strokeWidth={p.active ? 1.5 : 1}
                strokeOpacity={p.active ? 0.7 : 0.5}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            ))}
          </svg>
          {edgePaths
            .filter((p) => p.showLabel)
            .map((p) => (
              <div
                key={p.id}
                className={cn(
                  "pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background px-2.5 py-1 text-[11px] font-medium whitespace-nowrap",
                  p.active ? "border-primary/30 text-primary" : "border-border text-muted-foreground/70"
                )}
                style={{ left: p.midX, top: p.midY }}
              >
                {p.label}
              </div>
            ))}
          {columns.map((col, ci) => (
            <div key={ci} className="flex flex-col gap-10">
              {col.map((node) => {
                const isDim = dimmed(node.id)
                return (
                  <motion.div
                    key={node.id}
                    data-node-card
                    ref={(el) => {
                      if (el) nodeRefs.current.set(node.id, el)
                      else nodeRefs.current.delete(node.id)
                    }}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: isDim ? 0.35 : 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.35, delay: ci * 0.1 }}
                    onClick={() => {
                      setInspected(node)
                      onNodeClick?.(node)
                    }}
                    className={cn(
                      "w-44 cursor-pointer rounded-md border bg-card px-3 py-2 transition-shadow",
                      "hover:border-primary/40",
                      node.role === "resolved" ? "border-primary/50" : "border-border",
                      node.role === "conflict" && "border-dashed border-primary/60",
                      !isDim && highlightedNodeIds?.includes(node.id) && "ring-2 ring-primary/50"
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <NodeIcon kind={node.kind} className="size-3.5" />
                      <span className="text-[10px]">{node.kind}</span>
                    </div>
                    <div className="mt-1 truncate text-sm font-semibold">{node.label}</div>
                    {node.subtitle && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">{node.subtitle}</div>
                    )}
                  </motion.div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      {inspected && (
        <div ref={inspectorRef} className="border-t border-border/70 px-4 py-3 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <NodeIcon kind={inspected.kind} className="size-3.5 text-muted-foreground" />
              <span className="font-semibold">{inspected.label}</span>
            </div>
            <div className="flex items-center gap-3">
              {inspected.content && (
                <button
                  type="button"
                  onClick={() => setViewingNode(inspected)}
                  className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <FileText className="size-3.5" />
                  View document
                </button>
              )}
              <button type="button" onClick={() => setInspected(null)} className="text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </div>
          </div>

          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <dt>Type</dt>
            <dd>{inspected.kind}</dd>
            {trace.edges
              .filter((e) => e.to === inspected.id && e.reason)
              .map((e) => (
                <React.Fragment key={e.id}>
                  <dt>Why relevant</dt>
                  <dd>{e.reason}</dd>
                </React.Fragment>
              ))}
          </dl>

          {/* A preview, not the document: clipped to a fixed height with the
              cut edge faded so it reads as "there is more", and the whole thing
              opens the full viewer. Clipping the real renderer rather than
              truncating the string keeps the preview in the shape of its source
              (a Slack thread still looks like a thread) at the cost of cutting
              mid-message, which the fade is there to signal. */}
          {inspected.content && (
            <button
              type="button"
              onClick={() => setViewingNode(inspected)}
              aria-label="View full document"
              className="group/preview relative mt-2.5 block w-full overflow-hidden text-left"
              style={{ maxHeight: PREVIEW_MAX_HEIGHT }}
            >
              <ContentView node={inspected} compact />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-card via-card/80 to-transparent">
                <span className="pb-1 text-[10px] font-medium text-muted-foreground transition-colors group-hover/preview:text-foreground">
                  Click to read the rest
                </span>
              </div>
            </button>
          )}

          {/* Every raw property on the node, exact key names — the point is that
              a claim like "assigned on March 5" can be checked against what the
              graph actually records (e.g. `created_at`), not a paraphrase of it. */}
          {(() => {
            const hidden = new Set(["content", "text", "body", "description"])
            const entries = Object.entries(inspected.properties ?? {}).filter(([k, v]) => !hidden.has(k) && v !== "")
            if (entries.length === 0) return null
            return (
              <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border/50 pt-2.5 text-muted-foreground">
                {entries.map(([key, value]) => (
                  <React.Fragment key={key}>
                    <dt className="font-mono text-[10px]">{key}</dt>
                    <dd className="truncate text-foreground">{String(value)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )
          })()}
        </div>
      )}
      <Dialog.Root open={!!viewingNode} onOpenChange={(open) => !open && setViewingNode(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-card shadow-xl outline-none">
            <div className="flex items-center justify-between border-b border-border/70 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <NodeIcon kind={viewingNode?.kind ?? ""} className="size-4 text-muted-foreground" />
                <div>
                  <Dialog.Title className="text-sm font-semibold">{viewingNode?.label}</Dialog.Title>
                  {viewingNode?.subtitle && (
                    <div className="text-xs text-muted-foreground">{viewingNode.subtitle}</div>
                  )}
                </div>
              </div>
              <Dialog.Close className="text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </Dialog.Close>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              {viewingNode && <ContentView node={viewingNode} />}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

function layoutColumns(trace: Trace): TraceNode[][] {
  const depth = new Map<string, number>()
  const incoming = new Map<string, string[]>()
  for (const edge of trace.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from])
  }

  const roots = trace.nodes.filter((n) => n.role === "resolved" || !incoming.has(n.id))
  const queue: TraceNode[] = roots.length > 0 ? roots : trace.nodes.slice(0, 1)
  for (const r of queue) depth.set(r.id, 0)

  let frontier = queue
  while (frontier.length > 0) {
    const next: TraceNode[] = []
    for (const node of frontier) {
      const d = depth.get(node.id) ?? 0
      for (const edge of trace.edges) {
        if (edge.from !== node.id) continue
        const target = trace.nodes.find((n) => n.id === edge.to)
        if (!target) continue
        const existing = depth.get(target.id)
        if (existing === undefined || existing < d + 1) {
          depth.set(target.id, d + 1)
          next.push(target)
        }
      }
    }
    frontier = next
  }

  for (const node of trace.nodes) {
    if (!depth.has(node.id)) depth.set(node.id, 0)
  }

  const maxDepth = Math.max(0, ...Array.from(depth.values()))
  const columns: TraceNode[][] = Array.from({ length: maxDepth + 1 }, () => [])
  for (const node of trace.nodes) {
    columns[depth.get(node.id) ?? 0]!.push(node)
  }
  return columns
}
