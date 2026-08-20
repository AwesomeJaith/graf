import { runQueryHttp, singleSourcePaths, type GraphPath } from "@workspace/graph-client"
import type { GraphSchema } from "@workspace/graph-schema"

import type { ResolvedNode, TraceEdge, TraceNode } from "./types"

const MAX_HOPS = 3
const MAX_NODES = 40
const MAX_PATHS_PER_SOURCE = 20

/**
 * Expansion via HydraDB's native `algo.SSpaths` path procedure — one query
 * per resolved entity returns real bounded paths (nodes + relationships,
 * with actual relationship ids/properties) instead of stitching together
 * many single-type MATCH calls. This is the graph-native traversal the
 * answer and the trace are built from.
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

  for (const rn of resolvedNodes) {
    const spec = singleSourcePaths(rn.id, {
      relTypes,
      relDirection: "both",
      maxLen: MAX_HOPS,
      pathCount: MAX_PATHS_PER_SOURCE,
    })
    let rows: Record<string, unknown>[]
    try {
      rows = await runQueryHttp(spec.query, spec.params)
    } catch {
      continue // no matching relationships from this source at all; not an error worth surfacing
    }

    for (const row of rows) {
      const path = row.path as GraphPath | undefined
      if (!path) continue
      for (const node of path.nodes) {
        if (nodes.has(node.id) || nodes.size >= MAX_NODES) continue
        nodes.set(node.id, { id: node.id, label: node.label, primaryText: node.primaryText, role: "hop", properties: node.properties })
      }
      for (const rel of path.relationships) {
        const key = `${rel.sourceId}-${rel.type}-${rel.destinationId}`
        if (edges.has(key)) continue
        edges.set(key, { id: key, from: rel.sourceId, to: rel.destinationId, type: rel.type, properties: rel.properties })
      }
    }
  }

  // Drop edges whose endpoints didn't make it into the (size-capped) node set.
  const finalEdges = Array.from(edges.values()).filter((e) => nodes.has(e.from) && nodes.has(e.to))
  return { nodes: Array.from(nodes.values()), edges: finalEdges }
}
