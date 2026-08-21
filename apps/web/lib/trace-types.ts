// UI-facing shape for a chat turn's graph-native retrieval result. The API
// route maps whatever @workspace/graph-client returns into this contract —
// this file is the boundary the UI is built against.

export type TraceNodeRole = "resolved" | "hop" | "evidence" | "conflict"

export interface TraceNode {
  id: string
  label: string
  kind: string // e.g. "Person", "Project", "Message", "Document", "Decision"
  role: TraceNodeRole
  subtitle?: string
  /** Full body text (Message.text, Document.content, Issue/Task.body, ...) — what the node inspector renders. */
  content?: string
  /** Every raw property on the node (source, url, created_at, ... whatever the label declares), so a claim can be checked against the actual data instead of a paraphrase. */
  properties: Record<string, string | number | boolean>
}

export interface TraceEdge {
  id: string
  from: string
  to: string
  type: string // relationship type, e.g. WORKS_ON
  reason?: string // why this edge was considered relevant
}

export interface Trace {
  nodes: TraceNode[]
  edges: TraceEdge[]
}

export interface AnswerClaim {
  id: string
  text: string
  supportingNodeIds: string[]
  supportingEdgeIds: string[]
}

export type RetrievalStageKey = "resolving" | "searching" | "traversing" | "evaluating" | "answered"

export interface RetrievalStage {
  key: RetrievalStageKey
  label: string
  detail?: string
}

export interface EntityCandidate {
  id: string
  name: string
  type: string
  confidence: number
  subtitle?: string
}

export interface EntityResolution {
  mention: string
  candidates: EntityCandidate[]
  resolvedId?: string
}

export interface ConflictCandidate {
  value: string
  source: string
  timestamp: string
  nodeId: string
}

export interface Conflict {
  id: string
  subject: string
  candidates: ConflictCandidate[]
  selectedNodeId: string
  rationale: string
}

export type ResponseMode = "concise" | "normal" | "verbose"

export interface ChatTurnResult {
  reasoning: string
  answer: string
  claims: AnswerClaim[]
  trace: Trace
  entityResolutions: EntityResolution[]
  conflicts: Conflict[]
  stages: RetrievalStage[]
  notFound?: boolean
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  text: string
  result?: ChatTurnResult
  pending?: boolean
}

/**
 * A turn that produced no evidence, only a sentence: cancelled, interrupted, or
 * failed. `notFound` is what routes it to the plain-text branch of the turn
 * renderer, so there's no empty reasoning panel or zero-node graph hung off it.
 *
 * Shared because two unrelated paths need to look identical in the transcript —
 * the client giving up on a fetch, and the server clearing a `pending` row that
 * outlived its request — and a turn that renders differently depending on which
 * one stopped it would just read as a bug.
 */
export function terminalResult(answer: string): ChatTurnResult {
  return {
    reasoning: "",
    answer,
    claims: [],
    trace: { nodes: [], edges: [] },
    entityResolutions: [],
    conflicts: [],
    stages: [],
    notFound: true,
  }
}
