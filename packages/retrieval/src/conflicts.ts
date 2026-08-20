import type { TraceEdge, TraceNode } from "./types"

export interface DetectedConflict {
  edgeType: "CONTRADICTS" | "SUPERSEDES"
  nodeAId: number
  nodeBId: number
  selectedNodeId: number
  reason: string
}

const TIMESTAMP_KEYS = ["decided_at", "sent_at", "created_at", "updated_at"]

function pickTimestamp(node: TraceNode): string | undefined {
  for (const key of TIMESTAMP_KEYS) {
    const value = node.properties[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

/**
 * Conflict detection is a graph fact, not an LLM guess: a CONTRADICTS or
 * SUPERSEDES edge between two evidence nodes IS the conflict, and which side
 * wins is decided deterministically (explicit SUPERSEDES direction, or the
 * later timestamp) — see prompt.md's "the reasoning behind the selection
 * should be inspectable" requirement.
 */
export function detectConflicts(nodes: TraceNode[], edges: TraceEdge[]): DetectedConflict[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const results: DetectedConflict[] = []
  const seenPairs = new Set<string>()

  // A node pair can carry both a CONTRADICTS and a SUPERSEDES edge (the
  // demo/bench data does); SUPERSEDES is the more specific claim, so when
  // both exist for the same pair, report the pair once via SUPERSEDES.
  const sortedEdges = [...edges].sort((a, b) => (a.type === "SUPERSEDES" ? -1 : b.type === "SUPERSEDES" ? 1 : 0))

  for (const edge of sortedEdges) {
    if (edge.type !== "CONTRADICTS" && edge.type !== "SUPERSEDES") continue
    const pairKey = [edge.from, edge.to].sort((x, y) => x - y).join("-")
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)

    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b) continue

    if (edge.type === "SUPERSEDES") {
      results.push({
        edgeType: "SUPERSEDES",
        nodeAId: a.id,
        nodeBId: b.id,
        selectedNodeId: a.id,
        reason: `"${a.primaryText}" explicitly supersedes "${b.primaryText}".`,
      })
      continue
    }

    const ta = pickTimestamp(a)
    const tb = pickTimestamp(b)
    if (ta && tb) {
      const selected = ta >= tb ? a : b
      const winner = ta >= tb ? ta : tb
      results.push({
        edgeType: "CONTRADICTS",
        nodeAId: a.id,
        nodeBId: b.id,
        selectedNodeId: selected.id,
        reason: `More recent record (${winner}) takes precedence.`,
      })
    } else {
      results.push({
        edgeType: "CONTRADICTS",
        nodeAId: a.id,
        nodeBId: b.id,
        selectedNodeId: a.id,
        reason: `Both records conflict and neither has a comparable timestamp; defaulting to "${a.primaryText}".`,
      })
    }
  }

  return results
}

export { pickTimestamp }
