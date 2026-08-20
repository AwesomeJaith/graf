import type { GraphSchema } from "@workspace/graph-schema"

/** Compact text description of the active schema, injected into every pipeline prompt. */
export function describeSchema(schema: GraphSchema): string {
  const nodeLines = schema.nodeLabels
    .map((n) => `- ${n.label}: ${n.description} (properties: ${n.properties.map((p) => p.name).join(", ")})`)
    .join("\n")
  const relLines = schema.relationships
    .map((r) => `- (${r.from.join("|")})-[:${r.type}]->(${r.to.join("|")}): ${r.description}`)
    .join("\n")
  return `Graph "${schema.name}": ${schema.description}\n\nNode labels:\n${nodeLines}\n\nRelationship types:\n${relLines}`
}
