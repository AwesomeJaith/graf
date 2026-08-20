/**
 * Universal node shape returned by traversal queries. Every node written to
 * HydraDB by Graf carries `label` and `primary_text` as plain scalar
 * properties (in addition to its schema-declared properties) because the
 * Cypher subset can only RETURN `<binding>.<property>` projections — it
 * cannot project `labels(n)` or a literal string. Storing the label and a
 * display string as real properties is what lets traversal queries stay
 * label-agnostic and schema-driven instead of hardcoding a label per query.
 */
export interface GraphNode {
  id: number
  label: string
  primaryText: string
  properties: Record<string, string | number | boolean>
}

export interface GraphRelationship {
  id: number
  type: string
  sourceId: number
  destinationId: number
  properties: Record<string, string | number | boolean>
}

export interface GraphPath {
  nodes: GraphNode[]
  relationships: GraphRelationship[]
  weight?: number
  cost?: number
}

export type Direction = "outgoing" | "incoming" | "both"
