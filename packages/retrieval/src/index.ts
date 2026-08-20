import { loadGraphSchema } from "@workspace/graph-schema"

import { detectConflicts } from "./conflicts"
import { pickTimestamp } from "./conflicts"
import { fetchResolvedNode, planQuery, resolveEntities, type EntityOverride } from "./resolve"
import { synthesizeAnswer } from "./synthesize"
import { expandGraph } from "./traverse"
import type { AnswerResult, Conflict, ResponseMode, TraceNode } from "./types"

export * from "./types"
export { planQuery, resolveEntities, type EntityOverride } from "./resolve"
export { expandGraph } from "./traverse"
export { detectConflicts } from "./conflicts"
export { synthesizeAnswer } from "./synthesize"

/**
 * Full pipeline: query understanding -> entity resolution -> graph query
 * planning -> HydraDB traversal -> evidence collection -> temporal/conflict
 * reasoning -> answer synthesis. Every field on the returned AnswerResult
 * traces back to a real query result, not a display fiction.
 */
export async function answerQuestion(
  question: string,
  mode: ResponseMode = "normal",
  overrides: EntityOverride[] = []
): Promise<AnswerResult> {
  const schema = loadGraphSchema()

  const plan = await planQuery(question, schema)
  const entityResolutions = await resolveEntities(question, plan, schema, overrides)

  const resolvedNodes = (
    await Promise.all(
      entityResolutions.map(async (res) => {
        const candidate = res.candidates.find((c) => c.id === res.resolvedId)
        if (!candidate) return undefined
        return fetchResolvedNode(candidate.label, res.resolvedId, schema)
      })
    )
  ).filter((n): n is NonNullable<typeof n> => Boolean(n))

  if (resolvedNodes.length === 0) {
    return {
      question,
      mode,
      entityResolutions,
      nodes: [],
      edges: [],
      conflicts: [],
      answer: "I couldn't find any entities in the graph matching that question.",
      claims: [],
      notFound: true,
    }
  }

  const { nodes, edges } = await expandGraph(resolvedNodes, schema, plan.focusRelationshipTypes)
  const detected = detectConflicts(nodes, edges)

  const synth = await synthesizeAnswer(question, mode, nodes, edges, detected)

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const conflictNodeIds = new Set(detected.flatMap((c) => [c.nodeAId, c.nodeBId]))
  const citedNodeIds = new Set(synth.claims.flatMap((c) => c.supportingNodeIds))

  const finalNodes: TraceNode[] = nodes.map((n) => {
    if (n.role === "resolved") return n
    if (conflictNodeIds.has(n.id)) return { ...n, role: "conflict" }
    if (citedNodeIds.has(n.id)) return { ...n, role: "evidence" }
    return n
  })

  const conflicts: Conflict[] = detected.map((c, i) => {
    const desc = synth.conflictDescriptions.get(i)
    const a = nodeById.get(c.nodeAId)
    const b = nodeById.get(c.nodeBId)
    const toCandidate = (n: TraceNode | undefined) =>
      n
        ? {
            value: n.primaryText,
            source: typeof n.properties.source === "string" ? n.properties.source : "graph",
            timestamp: pickTimestamp(n) ?? "",
            nodeId: n.id,
          }
        : undefined
    return {
      id: `conflict-${i}`,
      subject: desc?.subject ?? `${a?.label ?? "record"} conflict`,
      candidates: [toCandidate(a), toCandidate(b)].filter((v): v is NonNullable<typeof v> => Boolean(v)),
      selectedNodeId: c.selectedNodeId,
      rationale: desc?.rationale ?? c.reason,
    }
  })

  return {
    question,
    mode,
    entityResolutions,
    nodes: finalNodes,
    edges,
    conflicts,
    answer: synth.answer,
    claims: synth.claims,
    notFound: synth.notFound,
  }
}
