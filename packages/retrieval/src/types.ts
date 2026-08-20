export type NodeRole = "resolved" | "hop" | "evidence" | "conflict"

export interface ResolvedNode {
  id: number
  label: string
  primaryText: string
  properties: Record<string, string | number | boolean>
}

export interface EntityCandidate {
  id: number
  label: string
  primaryText: string
  confidence: number
  subtitle?: string
}

export interface EntityResolution {
  mention: string
  candidates: EntityCandidate[]
  resolvedId: number
}

export interface TraceNode {
  id: number
  label: string
  primaryText: string
  role: NodeRole
  properties: Record<string, string | number | boolean>
}

export interface TraceEdge {
  id: string
  from: number
  to: number
  type: string
  reason?: string
}

export interface Conflict {
  id: string
  subject: string
  candidates: { value: string; source: string; timestamp: string; nodeId: number }[]
  selectedNodeId: number
  rationale: string
}

export interface Claim {
  id: string
  text: string
  supportingNodeIds: number[]
}

export type ResponseMode = "concise" | "normal" | "verbose"

export interface AnswerResult {
  question: string
  mode: ResponseMode
  entityResolutions: EntityResolution[]
  nodes: TraceNode[]
  edges: TraceEdge[]
  conflicts: Conflict[]
  answer: string
  claims: Claim[]
  notFound: boolean
}
