import { callStructured } from "./llm"
import { pickTimestamp, type DetectedConflict } from "./conflicts"
import type { Claim, ResponseMode, TraceEdge, TraceNode } from "./types"

const MODE_INSTRUCTIONS: Record<ResponseMode, string> = {
  concise: "Answer in one short sentence. No caveats, no evidence walkthrough.",
  normal: "Answer in one short paragraph (2-4 sentences). State the answer plainly, then the key supporting fact.",
  verbose:
    "Answer thoroughly: state the answer, then walk through the supporting evidence and any relevant caveats or conflicting information in full sentences.",
}

interface SynthesizeOutput {
  reasoning: string
  answer: string
  claims: { text: string; supportingNodeIds: number[] }[]
  notFound: boolean
  conflictDescriptions: { index: number; subject: string; rationale: string }[]
}

const SYNTHESIZE_SCHEMA = {
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description:
        "Your work, written out before the answer: which entities you're treating as resolved, which nodes/edges you actually used and why, how you weighed any conflicting or temporal evidence, and why the rest of the evidence didn't make the cut. Written for someone auditing the answer, not the person who asked the question.",
    },
    answer: { type: "string" },
    claims: {
      type: "array",
      description:
        "Break the answer into its key factual claims. Each `text` MUST be an exact, verbatim, contiguous substring of `answer` (same characters, same casing).",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          supportingNodeIds: { type: "array", items: { type: "number" } },
        },
        required: ["text", "supportingNodeIds"],
      },
    },
    notFound: {
      type: "boolean",
      description: "True if the evidence below is insufficient to answer the question — do not guess.",
    },
    conflictDescriptions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          subject: { type: "string", description: "Short label for what's conflicting, e.g. 'Atlas launch date'." },
          rationale: { type: "string", description: "One sentence on why the selected side was chosen." },
        },
        required: ["index", "subject", "rationale"],
      },
    },
  },
  required: ["reasoning", "answer", "claims", "notFound", "conflictDescriptions"],
}

export interface SynthesizeResult {
  reasoning: string
  answer: string
  claims: Claim[]
  notFound: boolean
  conflictDescriptions: Map<number, { subject: string; rationale: string }>
}

export async function synthesizeAnswer(
  question: string,
  mode: ResponseMode,
  nodes: TraceNode[],
  edges: TraceEdge[],
  conflicts: DetectedConflict[]
): Promise<SynthesizeResult> {
  const evidenceLines = nodes
    .map((n) => {
      const ts = pickTimestamp(n)
      const source = n.properties.source
      return `- id=${n.id} [${n.label}] "${n.primaryText}"${ts ? ` (${ts})` : ""}${source ? ` source=${source}` : ""}`
    })
    .join("\n")

  const edgeLines = edges
    .map((e) => {
      const props = Object.entries(e.properties)
      const propStr = props.length > 0 ? ` {${props.map(([k, v]) => `${k}: ${v}`).join(", ")}}` : ""
      return `- ${e.from} -[${e.type}${propStr}]-> ${e.to}`
    })
    .join("\n")

  const conflictLines = conflicts
    .map(
      (c, i) =>
        `${i}. Node ${c.nodeAId} vs node ${c.nodeBId} (${c.edgeType} edge). Graph reasoning selected node ${c.selectedNodeId} as current: ${c.reason}`
    )
    .join("\n")

  const out = await callStructured<SynthesizeOutput>({
    system: `You are Graf, an enterprise assistant that answers questions using only the graph evidence provided. ${MODE_INSTRUCTIONS[mode]} If a conflict is listed, respect the graph's selected side rather than re-deciding it yourself, but you may explain it. Relationship properties like valid_from/valid_to mark when that relationship was true — for "who was responsible/owned X when Y happened" questions, pick the person whose valid_from/valid_to range actually covers the relevant date, not everyone who was ever connected to that entity. A missing/empty valid_to means the relationship is still current. Never invent facts not present in the evidence, and never infer a specific claimed action (e.g. "approved", "decided", "confirmed") from a weaker relationship like authorship or mention — if the evidence doesn't contain that specific action or statement, set notFound=true and say so plainly rather than guessing from adjacent context.`,
    prompt: [
      `Question: ${question}`,
      "",
      "Graph nodes touched during retrieval:",
      evidenceLines || "(none)",
      "",
      "Relationships traversed:",
      edgeLines || "(none)",
      "",
      "Detected conflicts (already resolved by graph/temporal reasoning):",
      conflictLines || "(none)",
    ].join("\n"),
    toolName: "synthesize_answer",
    toolDescription: "Produce the final answer with claim-level evidence citations.",
    inputSchema: SYNTHESIZE_SCHEMA,
  })

  // Defensive: forced tool-use still occasionally omits an optional-shaped
  // array field on a long/constrained question rather than sending `[]`.
  const claims: Claim[] = Array.isArray(out.claims)
    ? out.claims
        .filter((c) => typeof c?.text === "string" && out.answer.includes(c.text))
        .map((c, i) => ({ id: `claim-${i}`, text: c.text, supportingNodeIds: Array.isArray(c.supportingNodeIds) ? c.supportingNodeIds : [] }))
    : []

  return {
    reasoning: typeof out.reasoning === "string" ? out.reasoning : "",
    answer: out.answer,
    claims,
    notFound: Boolean(out.notFound),
    conflictDescriptions: new Map(
      Array.isArray(out.conflictDescriptions) ? out.conflictDescriptions.map((d) => [d.index, { subject: d.subject, rationale: d.rationale }]) : []
    ),
  }
}
