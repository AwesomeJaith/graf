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
  source?: string
  timestamp?: string
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
