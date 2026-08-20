import { expandNeighborhood, runGraphQuery, stripRendererKeys } from "@workspace/graph-client"
import type { GraphSchema } from "@workspace/graph-schema"

import type { ResolvedNode, TraceEdge, TraceNode } from "./types"

const MAX_HOPS = 3
const MAX_NODES = 40
/** Per-label cap on one hop's expansion — a hub node (a Project with 30k tasks) would otherwise flood the frontier. */
const MAX_ROWS_PER_EXPANSION = 200

interface ExpansionRow {
  sourceId: number
  destinationId: number
  relId: number
  relType: string
  rel?: Record<string, unknown>
  nodeId: number
  nodeLabel?: string
  nodePrimaryText?: string
  node?: Record<string, unknown>
}

/**
 * Breadth-first expansion from every resolved entity, one query per
 * (hop, label) group.
 *
 * This used to be a single `algo.SSpaths` call per entity, which returned whole
 * bounded paths in one shot. HydraDB Cloud rejects all procedure calls, so the
 * walk is driven client-side over `expandNeighborhood` instead: each round
 * takes the current frontier, expands it one untyped hop in both directions,
 * and keeps the new neighbors as the next frontier. Same traversal, same trace
 * — the difference is that the hop boundary is now explicit here rather than
 * inside the engine, which also makes the per-hop node budget enforceable
 * instead of relying on a `pathCount` heuristic.
 *
 * Ids come from explicit `.id` projections, never from a returned node's `id`
 * key: the cloud renderer overwrites that with a collection-internal id.
 */
export async function expandGraph(
  resolvedNodes: ResolvedNode[],
  schema: GraphSchema,
  focusRelationshipTypes: string[]
): Promise<{ nodes: TraceNode[]; edges: TraceEdge[] }> {
  const nodes = new Map<number, TraceNode>()
  const edges = new Map<string, TraceEdge>()

  for (const rn of resolvedNodes) {
    nodes.set(rn.id, { id: rn.id, label: rn.label, primaryText: rn.primaryText, role: "resolved", properties: rn.properties })
  }

  // Conflict/supersession edges are always worth walking even if the query
  // planner didn't think to ask for them — temporal/conflict reasoning is a
  // cross-cutting concern, not something every question plan should have to
  // know to request.
  const CONFLICT_TYPES = ["CONTRADICTS", "SUPERSEDES"]
  const allTypes = schema.relationships.map((r) => r.type)
  const relTypes =
    focusRelationshipTypes.length > 0
      ? Array.from(new Set([...focusRelationshipTypes, ...allTypes.filter((t) => CONFLICT_TYPES.includes(t))]))
      : allTypes
  if (relTypes.length === 0) return { nodes: Array.from(nodes.values()), edges: [] }

  // Frontier is grouped by label because the expansion query has to name one:
  // a labelless `MATCH (a {id: ...})` can't use the id index and full-scans.
  let frontier = groupByLabel(resolvedNodes.map((rn) => ({ id: rn.id, label: rn.label })))

  for (let hop = 0; hop < MAX_HOPS && frontier.size > 0 && nodes.size < MAX_NODES; hop++) {
    const groups = Array.from(frontier.entries())
    const results = await Promise.all(
      groups.map(async ([label, ids]) => {
        const spec = expandNeighborhood(label, ids, relTypes, MAX_ROWS_PER_EXPANSION)
        try {
          return (await runGraphQuery(spec.query, spec.params)) as unknown as ExpansionRow[]
        } catch {
          return [] // no matching relationships from this group at all; not an error worth surfacing
        }
      })
    )

    const discovered: { id: number; label: string }[] = []
    for (const row of results.flat()) {
      if (typeof row.nodeId === "number" && !nodes.has(row.nodeId) && nodes.size < MAX_NODES) {
        const label = row.nodeLabel ?? ""
        nodes.set(row.nodeId, {
          id: row.nodeId,
          label,
          primaryText: row.nodePrimaryText ?? "",
          role: "hop",
          properties: stripRendererKeys(row.node),
        })
        discovered.push({ id: row.nodeId, label })
      }
      const key = `${row.sourceId}-${row.relType}-${row.destinationId}`
      if (!edges.has(key)) {
        edges.set(key, {
          id: key,
          from: row.sourceId,
          to: row.destinationId,
          type: row.relType,
          properties: stripRendererKeys(row.rel),
        })
      }
    }
    frontier = groupByLabel(discovered)
  }

  // Drop edges whose endpoints didn't make it into the (size-capped) node set.
  const finalEdges = Array.from(edges.values()).filter((e) => nodes.has(e.from) && nodes.has(e.to))
  return { nodes: Array.from(nodes.values()), edges: finalEdges }
}

function groupByLabel(items: { id: number; label: string }[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const { id, label } of items) {
    if (!label) continue
    const list = out.get(label) ?? []
    list.push(id)
    out.set(label, list)
  }
  return out
}
