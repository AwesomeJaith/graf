import { answerQuestion, type AnswerResult, type EntityOverride, type ResponseMode as PipelineMode, type TraceNode as PipelineNode } from "@workspace/retrieval"

import type { ChatTurnResult, Conflict, EntityResolution, ResponseMode, Trace, TraceEdge, TraceNode } from "@/lib/trace-types"

export const maxDuration = 60

interface ChatRequestBody {
  question: string
  mode?: ResponseMode
  overrides?: { mention: string; candidateId: number; label: string }[]
}

function subtitleFor(node: PipelineNode): string | undefined {
  const value = node.properties.title ?? node.properties.name ?? node.properties.summary ?? node.properties.status
  return typeof value === "string" ? value : undefined
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
    const result = await answerQuestion(body.question, (body.mode ?? "normal") as PipelineMode, overrides)
    return Response.json(toUiResult(result))
  } catch (err) {
    console.error("chat pipeline failed", err)
    return Response.json({ error: err instanceof Error ? err.message : "Pipeline failed." }, { status: 500 })
  }
}
