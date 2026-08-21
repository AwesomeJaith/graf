import { answerQuestion, type AnswerResult, type EntityOverride, type ResponseMode as PipelineMode, type TraceNode as PipelineNode } from "@workspace/retrieval"

import type { ChatTurnResult, Conflict, EntityResolution, ResponseMode, Trace, TraceEdge, TraceNode } from "@/lib/trace-types"

/**
 * A question with several entities in it spends 20-40s in LLM calls (see the
 * stage breakdown in packages/bench/README.md), and the tail runs past a minute
 * — so the default 60s ceiling was cutting off exactly the multi-constraint
 * questions the graph is best at. Vercel clamps this to whatever the plan
 * allows, so it's an upper bound rather than a reservation.
 */
export const maxDuration = 300

interface ChatRequestBody {
  question: string
  mode?: ResponseMode
  overrides?: { mention: string; candidateId: number; label: string }[]
}

/**
 * A second line for the node card, when there's a *different* one to show.
 *
 * The label is already the node's `primaryText`, and for most labels the first
 * candidate here is the property that primaryText was taken from — Person.name
 * and Document.title are the same string — so an unguarded pick renders every
 * card with its own title twice. Fall through to the next candidate instead of
 * repeating, and give up rather than showing a duplicate.
 */
function subtitleFor(node: PipelineNode): string | undefined {
  const normalize = (value: string) => value.trim().toLowerCase()
  const candidates = [node.properties.title, node.properties.name, node.properties.summary, node.properties.status]
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue
    if (normalize(candidate) === normalize(node.primaryText)) continue
    return candidate
  }
  return undefined
}

function contentFor(node: PipelineNode): string | undefined {
  const value = node.properties.content ?? node.properties.text ?? node.properties.body ?? node.properties.description
  return typeof value === "string" && value ? value : undefined
}

function toUiResult(result: AnswerResult): ChatTurnResult {
  const nodes: TraceNode[] = result.nodes.map((n) => ({
    id: String(n.id),
    label: n.primaryText,
    kind: n.label,
    role: n.role,
    subtitle: subtitleFor(n),
    content: contentFor(n),
    properties: n.properties,
  }))

  const edges: TraceEdge[] = result.edges.map((e) => ({
    id: e.id,
    from: String(e.from),
    to: String(e.to),
    type: e.type,
    reason: e.reason,
  }))

  const trace: Trace = { nodes, edges }

  const claims = result.claims.map((c) => {
    const supportingNodeIds = c.supportingNodeIds.map(String)
    const supportingEdgeIds = edges
      .filter((e) => supportingNodeIds.includes(e.from) && supportingNodeIds.includes(e.to))
      .map((e) => e.id)
    return { id: c.id, text: c.text, supportingNodeIds, supportingEdgeIds }
  })

  const conflicts: Conflict[] = result.conflicts.map((c) => ({
    id: c.id,
    subject: c.subject,
    candidates: c.candidates.map((cand) => ({
      value: cand.value,
      source: cand.source,
      timestamp: cand.timestamp,
      nodeId: String(cand.nodeId),
    })),
    selectedNodeId: String(c.selectedNodeId),
    rationale: c.rationale,
  }))

  const entityResolutions: EntityResolution[] = result.entityResolutions.map((r) => ({
    mention: r.mention,
    candidates: r.candidates.map((c) => ({
      id: String(c.id),
      name: c.primaryText,
      type: c.label,
      confidence: c.confidence,
      subtitle: c.subtitle,
    })),
    resolvedId: String(r.resolvedId),
  }))

  return {
    reasoning: result.reasoning,
    answer: result.answer,
    claims,
    trace,
    entityResolutions,
    conflicts,
    stages: [
      { key: "resolving", label: "Resolving entities" },
      { key: "searching", label: "Searching graph" },
      { key: "traversing", label: "Following relationships" },
      { key: "evaluating", label: "Evaluating evidence" },
      { key: "answered", label: "Answer found" },
    ],
    notFound: result.notFound,
  }
}

export async function POST(request: Request) {
  let body: ChatRequestBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  if (!body.question || typeof body.question !== "string") {
    return Response.json({ error: "`question` is required." }, { status: 400 })
  }

  try {
    const overrides: EntityOverride[] = body.overrides ?? []
    // `request.signal` fires on client disconnect as well as on an explicit
    // stop, so the pipeline stops rather than finishing a ~30s turn into a
    // socket nobody is reading — which on a rate-limited account is the
    // difference between a cancel freeing capacity and a cancel costing it.
    const result = await answerQuestion(body.question, (body.mode ?? "normal") as PipelineMode, overrides, request.signal)
    return Response.json(toUiResult(result))
  } catch (err) {
    // An abort isn't a failure, and the client that caused it has already
    // stopped listening — so no log line and no error body, both of which
    // would only be noise. 499 is nginx's "client closed request".
    if (request.signal.aborted) return new Response(null, { status: 499 })
    console.error("chat pipeline failed", err)
    return Response.json({ error: err instanceof Error ? err.message : "Pipeline failed." }, { status: 500 })
  }
}
