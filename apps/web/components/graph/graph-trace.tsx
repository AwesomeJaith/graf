"use client"

import * as React from "react"
import { motion } from "motion/react"

import { ExternalLink, X } from "lucide-react"

import type { Trace, TraceNode } from "@/lib/trace-types"
import { cn } from "@workspace/ui/lib/utils"
import { Markdown } from "../chat/markdown"
import { NodeIcon } from "./node-icon"

const MESSAGE_KINDS = new Set(["Message"])

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
}

// Groups nodes into columns by hop-distance from the resolved entities, then
// measures the real rendered DOM positions to draw connecting edges. The
// layout is derived entirely from `trace` — there is no separate mock graph,
// so whatever the retrieval pipeline actually touched is what renders here.
export function GraphTrace({ trace, highlightedNodeIds, highlightedEdgeIds, onNodeClick }: GraphTraceProps) {
  const columns = React.useMemo(() => layoutColumns(trace), [trace])
  const containerRef = React.useRef<HTMLDivElement>(null)
  const nodeRefs = React.useRef(new Map<string, HTMLDivElement>())
  const [edgePaths, setEdgePaths] = React.useState<EdgePath[]>([])
  const [inspected, setInspected] = React.useState<TraceNode | null>(null)

  const measure = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const paths: EdgePath[] = []
    for (const edge of trace.edges) {
      const from = nodeRefs.current.get(edge.from)
      const to = nodeRefs.current.get(edge.to)
      if (!from || !to) continue
      const fr = from.getBoundingClientRect()
      const tr = to.getBoundingClientRect()
      const x1 = fr.right - containerRect.left
      const y1 = fr.top + fr.height / 2 - containerRect.top
      const x2 = tr.left - containerRect.left
      const y2 = tr.top + tr.height / 2 - containerRect.top
      const midX = (x1 + x2) / 2
      paths.push({
        id: edge.id,
        d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
        midX,
        midY: (y1 + y2) / 2,
        label: edge.type.replace(/_/g, " ").toLowerCase(),
        active: !highlightedEdgeIds || highlightedEdgeIds.includes(edge.id),
      })
    }
    setEdgePaths(paths)
  }, [trace, highlightedEdgeIds])

  React.useLayoutEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
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
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
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
        {edgePaths.map((p) => (
          <div
            key={p.id}
            className={cn(
              "absolute -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background px-2.5 py-1 text-[11px] font-medium whitespace-nowrap",
              p.active ? "border-primary/30 text-primary" : "border-border text-muted-foreground/70"
            )}
            style={{ left: p.midX, top: p.midY }}
          >
            {p.label}
          </div>
        ))}
        <div className="relative flex items-start gap-32">
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
                      <span className="text-[10px] tracking-wide uppercase">{node.kind}</span>
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
        <div className="border-t border-border/70 px-4 py-3 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <NodeIcon kind={inspected.kind} className="size-3.5 text-muted-foreground" />
              <span className="font-semibold">{inspected.label}</span>
            </div>
            <button type="button" onClick={() => setInspected(null)} className="text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>

          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <dt>Type</dt>
            <dd>{inspected.kind}</dd>
            {inspected.source && (
              <>
                <dt>Source</dt>
                <dd>{inspected.source}</dd>
              </>
            )}
            {inspected.timestamp && (
              <>
                <dt>Timestamp</dt>
                <dd>{inspected.timestamp}</dd>
              </>
            )}
            {trace.edges
              .filter((e) => e.to === inspected.id && e.reason)
              .map((e) => (
                <React.Fragment key={e.id}>
                  <dt>Why relevant</dt>
                  <dd>{e.reason}</dd>
                </React.Fragment>
              ))}
          </dl>

          {inspected.content &&
            (MESSAGE_KINDS.has(inspected.kind) ? (
              <div className="mt-2.5 rounded-md bg-muted px-3 py-2 text-[0.8rem] text-foreground">{inspected.content}</div>
            ) : (
              <div className="mt-2.5 max-h-64 overflow-y-auto rounded-md bg-muted px-3 py-2.5">
                <Markdown className="text-[0.8rem]">{inspected.content}</Markdown>
              </div>
            ))}

          {inspected.url && (
            <a
              href={inspected.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="size-3" />
              Open source
            </a>
          )}
        </div>
      )}
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
