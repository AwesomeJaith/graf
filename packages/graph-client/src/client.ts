import neo4j, {
  type Driver,
  type Session,
  type Record as Neo4jRecord,
  type Node as Neo4jNode,
  type Relationship as Neo4jRelationship,
  type Path as Neo4jPath,
} from "neo4j-driver"
import { loadHydraDbConfig, type HydraDbConfig } from "./config"
import type { GraphNode, GraphPath, GraphRelationship } from "./types"

let driver: Driver | undefined

function buildAuth(config: HydraDbConfig) {
  if (config.authToken) return neo4j.auth.bearer(config.authToken)
  if (config.username && config.password)
    return neo4j.auth.basic(config.username, config.password)
  return undefined
}

export function getDriver(config: HydraDbConfig = loadHydraDbConfig()): Driver {
  if (driver) return driver
  const auth = buildAuth(config)
  driver = auth
    ? neo4j.driver(config.boltUri, auth)
    : neo4j.driver(config.boltUri)
  return driver
}

export async function closeDriver(): Promise<void> {
  if (!driver) return
  await driver.close()
  driver = undefined
}

export interface RunOptions {
  database?: string
}

/**
 * Path-procedure results carry the app-level `id`/`primary_text`/`label`
 * convention properties (see types.ts) *and* the engine's own Node/Relationship
 * wrapper (with real labels()/type() — the RETURN-projection limits noted in
 * cypher.ts don't apply here). A node's engine identity always equals its
 * `id` property (HydraDB identifies vertices by the id you give them), but a
 * relationship's engine identity is a separate internal counter from its
 * `id` property — mapRelationship below prefers the app property.
 */
function mapNode(node: Neo4jNode): GraphNode {
  const properties = unwrapValue(node.properties) as Record<
    string,
    string | number | boolean
  >
  const { id, label, primary_text, ...rest } = properties as Record<
    string,
    unknown
  >
  return {
    id: typeof id === "number" ? id : (unwrapValue(node.identity) as number),
    label: (label as string) ?? node.labels[0] ?? "",
    primaryText: (primary_text as string) ?? "",
    properties: rest as Record<string, string | number | boolean>,
  }
}

function mapRelationship(rel: Neo4jRelationship): GraphRelationship {
  const properties = unwrapValue(rel.properties) as Record<
    string,
    string | number | boolean
  >
  const { id, rel_type, ...rest } = properties as Record<string, unknown>
  return {
    id: typeof id === "number" ? id : (unwrapValue(rel.identity) as number),
    type: (rel_type as string) ?? rel.type,
    sourceId: unwrapValue(rel.start) as number,
    destinationId: unwrapValue(rel.end) as number,
    properties: rest as Record<string, string | number | boolean>,
  }
}

function mapPath(path: Neo4jPath): GraphPath {
  const nodes: GraphNode[] = [mapNode(path.start)]
  const relationships: GraphRelationship[] = []
  for (const segment of path.segments) {
    relationships.push(mapRelationship(segment.relationship))
    nodes.push(mapNode(segment.end))
  }
  return { nodes, relationships }
}

/** Unwraps neo4j-driver's Integer/Node/Relationship/Path wrapper types into plain JS values. */
export function unwrapValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (neo4j.isInt(value)) return value.toNumber()
  if (neo4j.isNode(value)) return mapNode(value)
  if (neo4j.isRelationship(value)) return mapRelationship(value)
  if (neo4j.isPath(value)) return mapPath(value)
  if (Array.isArray(value)) return value.map(unwrapValue)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    return Object.fromEntries(
      entries.map(([key, val]) => [key, unwrapValue(val)])
    )
  }
  return value
}

export function recordToObject(record: Neo4jRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of record.keys) {
    out[key as string] = unwrapValue(record.get(key as string))
  }
  return out
}

/**
 * Runs one Cypher statement and returns plain-object rows. HydraDB accepts
 * exactly one statement per request, so callers must not concatenate
 * multiple statements with `;`.
 */
export async function runQuery(
  query: string,
  params: Record<string, unknown> = {},
  opts: RunOptions = {}
): Promise<Record<string, unknown>[]> {
  const session: Session = getDriver().session({ database: opts.database })
  try {
    const result = await session.run(query, params)
    return result.records.map(recordToObject)
  } finally {
    await session.close()
  }
}

/** Runs several write statements as part of the same session, sequentially. */
export async function runWrites(
  statements: { query: string; params?: Record<string, unknown> }[],
  opts: RunOptions = {}
): Promise<void> {
  const session: Session = getDriver().session({ database: opts.database })
  try {
    for (const statement of statements) {
      await session.run(statement.query, statement.params ?? {})
    }
  } finally {
    await session.close()
  }
}
