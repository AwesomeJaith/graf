import { loadGraphSchema } from "@workspace/graph-schema"

import { attachBodyText } from "./body-text"
import { detectConflicts } from "./conflicts"
import { pickTimestamp } from "./conflicts"
import { rankNodeIdsByRelevance, searchContent } from "./content-search"
import { fetchResolvedNode, planQuery, resolveEntities, type EntityOverride } from "./resolve"
import { synthesizeAnswer } from "./synthesize"
import { expandGraph } from "./traverse"
import type { AnswerResult, Conflict, ResponseMode, TraceNode } from "./types"

export * from "./types"
export { planQuery, resolveEntities, type EntityOverride } from "./resolve"
export { expandGraph } from "./traverse"
export { detectConflicts } from "./conflicts"
export { synthesizeAnswer } from "./synthesize"
export { searchContent, searchMentions, type MentionCandidate } from "./content-search"

/**
 * Full pipeline: query understanding -> entity resolution -> graph query
 * planning -> HydraDB traversal -> evidence collection -> temporal/conflict
 * reasoning -> answer synthesis. Every field on the returned AnswerResult
 * traces back to a real query result, not a display fiction.
 */
export async function answerQuestion(
  question: string,
  mode: ResponseMode = "normal",
  overrides: EntityOverride[] = [],
  /**
   * Abandons the turn when the caller stops caring — a closed tab or a pressed
   * stop button. Passed into the Bedrock calls, which is where nearly all of a
   * turn's ~30s sits, and re-checked between stages so the non-abortable ones
   * (graph traversal, the local vector scan) can't carry a dead turn forward
   * into another model call. Left unthreaded through `embedText`: those are
   * sub-second, so the check on either side of them is close enough.
   */
  signal?: AbortSignal
): Promise<AnswerResult> {
  const schema = loadGraphSchema()

  const plan = await planQuery(question, schema, signal)
  const [entityResolutions, contentNodes] = await Promise.all([
    resolveEntities(question, plan, schema, overrides, signal),
    searchContent(question, schema),
  ])

  const entityNodes = (
    await Promise.all(
      entityResolutions.map(async (res) => {
        const candidate = res.candidates.find((c) => c.id === res.resolvedId)
        if (!candidate) return undefined
        return fetchResolvedNode(candidate.label, res.resolvedId, schema)
      })
    )
  ).filter((n): n is NonNullable<typeof n> => Boolean(n))

  // Named-entity resolution finds *who*/*what project*; content search finds
  // *which document/message actually has the answer* — most factual
  // questions ("what's the default size limit for...") have no person or
  // project mention to anchor on at all, so this is often the only entry
  // point into the graph.
  const entityNodeIds = new Set(entityNodes.map((n) => n.id))
  const contentNodeIds = new Set(contentNodes.map((n) => n.id))
  const resolvedNodes = [...entityNodes, ...contentNodes.filter((n) => !entityNodeIds.has(n.id))]

  if (resolvedNodes.length === 0) {
    return {
      question,
      mode,
      entityResolutions,
      nodes: [],
      edges: [],
      conflicts: [],
      reasoning: "No entities in the graph matched anything in the question, so there was no evidence to reason over.",
      answer: "I couldn't find any entities in the graph matching that question.",
      claims: [],
      notFound: true,
    }
  }

  signal?.throwIfAborted()
  const { nodes: bareNodes, edges } = await expandGraph(resolvedNodes, schema, plan.focusRelationshipTypes)
  // Document bodies aren't stored in the graph at full-corpus scale (they
  // exhausted the cloud instance's memory and no query ever filters on them) —
  // merge them back from the local sidecar here, once, before anything reads
  // node properties. A no-op when the graph does carry its own bodies.
  const nodes = attachBodyText(bareNodes)
  const detected = detectConflicts(nodes, edges)

  // Synthesis gets a relevance-filtered view of the touched content nodes
  // (top 8) so 20-30 mostly-structural traversal hops don't dilute the
  // model's precision on exact figures/names — the full set still drives
  // the trace/UI and conflict detection above.
  const contentIds = nodes.filter((n) => typeof n.properties.dsid === "string").map((n) => n.id)
  signal?.throwIfAborted()
  const keepContentIds = await rankNodeIdsByRelevance(question, contentIds, 8)
  const synthNodes = nodes.filter((n) => typeof n.properties.dsid !== "string" || keepContentIds.has(n.id))

  const synth = await synthesizeAnswer(question, mode, synthNodes, edges, detected, signal)

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const conflictNodeIds = new Set(detected.flatMap((c) => [c.nodeAId, c.nodeBId]))
  const citedNodeIds = new Set(synth.claims.flatMap((c) => c.supportingNodeIds))

  const finalNodes: TraceNode[] = nodes.map((n) => {
    if (n.role === "resolved" && entityNodeIds.has(n.id)) return n
    if (conflictNodeIds.has(n.id)) return { ...n, role: "conflict" }
    if (contentNodeIds.has(n.id) || citedNodeIds.has(n.id)) return { ...n, role: "evidence" }
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
    reasoning: synth.reasoning,
    answer: synth.answer,
    claims: synth.claims,
    notFound: synth.notFound,
  }
}
