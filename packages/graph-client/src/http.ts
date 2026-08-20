import neo4j from "neo4j-driver"
import { loadHydraDbConfig, type HydraDbConfig } from "./config"
import type { GraphNode, GraphPath, GraphRelationship } from "./types"

/**
 * HTTP/JSON transport for reads. Exists alongside the Bolt transport in
 * client.ts because running neo4j-driver's binary Bolt protocol inside
 * Next.js's Turbopack dev runtime corrupts its chunk framing (`RangeError:
 * offset is out of range` on session.run — reproducible only inside the
 * bundled Next process, not under plain node/tsx). Batched UNWIND writes
 * still require Bolt (see cypher-compat.md), so ingestion/seed scripts keep
 * using client.ts; this is only for the live app's read path.
 */

function toPlainParam(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (neo4j.isInt(value)) return value.toNumber()
  if (Array.isArray(value)) return value.map(toPlainParam)
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlainParam(v)]))
  }
  return value
}

function unwrapTaggedProperties(props: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, tagged] of Object.entries(props ?? {})) {
    if (tagged && typeof tagged === "object") {
      const first = Object.values(tagged as Record<string, unknown>)[0]
      out[key] = first as string | number | boolean
    } else {
      out[key] = tagged as string | number | boolean
    }
  }
  return out
}

interface HttpPathNode {
  id: number
  labels: string[]
  properties: Record<string, unknown>
}
interface HttpPathRel {
  id: number
  edge_type: string
  src: number
  dst: number
  properties: Record<string, unknown>
}

function unwrapHttpPath(raw: { nodes: HttpPathNode[]; relationships: HttpPathRel[] }): GraphPath {
  const nodes: GraphNode[] = raw.nodes.map((n) => {
    const properties = unwrapTaggedProperties(n.properties)
    const { label, primary_text, ...rest } = properties
    delete (rest as Record<string, unknown>).id
    return { id: n.id, label: (label as string) ?? n.labels[0] ?? "", primaryText: (primary_text as string) ?? "", properties: rest }
  })
  const relationships: GraphRelationship[] = raw.relationships.map((r) => {
    const properties = unwrapTaggedProperties(r.properties)
    const { id, rel_type, ...rest } = properties
    return {
      id: typeof id === "number" ? id : r.id,
      type: (rel_type as string) ?? r.edge_type,
      sourceId: r.src,
      destinationId: r.dst,
      properties: rest,
    }
  })
  return { nodes, relationships }
}

function unwrapHttpValue(cell: unknown): unknown {
  if (cell === null || cell === undefined) return cell
  if (typeof cell === "object" && "type" in cell && "value" in cell) {
    const { type, value } = cell as { type: string; value: unknown }
    if (type === "path") return unwrapHttpPath(value as { nodes: HttpPathNode[]; relationships: HttpPathRel[] })
    return value
  }
  return cell
}

export async function runQueryHttp(
  query: string,
  params: Record<string, unknown> = {},
  config: HydraDbConfig = loadHydraDbConfig()
): Promise<Record<string, unknown>[]> {
  if (!config.httpUri) throw new Error("HYDRADB_HTTP_URL is not set.")
  const response = await fetch(`${config.httpUri}/v1/graphs/${config.graphId ?? "default"}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.authToken}`,
      "X-Graph-Namespace": config.namespace ?? "default",
    },
    body: JSON.stringify({ cell_id: config.cellId ?? "cell-0", query, parameters: toPlainParam(params) }),
  })
  const body = await response.json()
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `HydraDB HTTP query failed with status ${response.status}`)
  }
  const columns: string[] = body.columns ?? []
  const rows: unknown[][] = body.rows ?? []
  return rows.map((row) => Object.fromEntries(columns.map((col, i) => [col, unwrapHttpValue(row[i])])))
}
