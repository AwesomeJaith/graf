import neo4j from "neo4j-driver"
import type { NodeLabelSchema } from "@workspace/graph-schema"
import type { Direction } from "./types"

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * neo4j-driver sends plain JS numbers as Bolt Float, but HydraDB requires
 * node/relationship ids to be non-negative integers — every id-shaped
 * parameter has to go through neo4j.int() or the server rejects the query.
 */
function toInt(value: number) {
  return neo4j.int(value)
}

/**
 * Cypher labels and relationship types can't be parameterized — HydraDB's
 * parser needs them inline in the query text. They come from GraphSchema
 * (trusted config), but we still guard against anything that isn't a plain
 * identifier before splicing it into a query string.
 */
export function assertIdentifier(name: string, kind: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Invalid ${kind} identifier: ${JSON.stringify(name)}`)
  }
  return name
}

function directionArrows(direction: Direction): {
  left: string
  right: string
} {
  if (direction === "outgoing") return { left: "-", right: "->" }
  if (direction === "incoming") return { left: "<-", right: "-" }
  return { left: "-", right: "-" }
}

export interface QuerySpec {
  query: string
  params: Record<string, unknown>
}

/**
 * Every node Graf writes carries `label` and `primary_text` as real scalar
 * properties (see types.ts) precisely so generic reads can project them
 * without knowing the label ahead of time. `extra` should be the property
 * list from the matched GraphSchema entry, when known.
 */
function projectNode(alias: string, extra: string[] = []): string {
  const base = [
    `${alias}.id AS id`,
    `${alias}.label AS label`,
    `${alias}.primary_text AS primary_text`,
  ]
  const rest = extra
    .filter(
      (prop) => prop !== "id" && prop !== "label" && prop !== "primary_text"
    )
    .map((prop) => `${alias}.${assertIdentifier(prop, "property")} AS ${prop}`)
  return [...base, ...rest].join(", ")
}

/** Full node detail by id, projecting every property declared for that label in the schema. */
export function getNodeById(
  label: string,
  id: number,
  schemaEntry?: NodeLabelSchema
): QuerySpec {
  assertIdentifier(label, "label")
  const extra = schemaEntry?.properties.map((p) => p.name) ?? []
  return {
    query: `MATCH (n:${label} {id: $id}) RETURN ${projectNode("n", extra)}`,
    params: { id: toInt(id) },
  }
}

/** Batch node-detail lookup by id, single label, via the transport-level UNWIND form. */
export function getNodesByIdBatch(
  label: string,
  ids: number[],
  schemaEntry?: NodeLabelSchema
): QuerySpec {
  assertIdentifier(label, "label")
  const extra = schemaEntry?.properties.map((p) => p.name) ?? []
  return {
    query: `UNWIND $ids AS row MATCH (n:${label} {id: row.id}) RETURN ${projectNode("n", extra)}`,
    params: { ids: ids.map((id) => ({ id: toInt(id) })) },
  }
}

/** Exact-match lookup on one scalar property (e.g. email). Not fuzzy — that's vector-index's job. */
export function findNodesByProperty(
  label: string,
  property: string,
  value: string | number | boolean
): QuerySpec {
  assertIdentifier(label, "label")
  assertIdentifier(property, "property")
  return {
    query: `MATCH (n:${label}) WHERE n.${property} = $value RETURN ${projectNode("n")} LIMIT 50`,
    params: { value },
  }
}

/**
 * One-hop traversal in a given direction over exactly one relationship type.
 * Projects the destination node plus `r.rel_type` (the app-level convention
 * property, see types.ts). Does NOT project `r.id`: HydraDB's parser rejects
 * that specific projection ("unbound variable r") even though the
 * relationship is named and bound in the pattern — every other relationship
 * property projects fine. A relationship's own numeric id is only reachable
 * through the `algo.*` path procedures below, which return whole path
 * objects rather than individual property projections.
 */
export function traverseOneHop(
  fromId: number,
  relType: string,
  direction: Direction
): QuerySpec {
  assertIdentifier(relType, "relationship type")
  const { left, right } = directionArrows(direction)
  return {
    query: `MATCH (a {id: $fromId})${left}[r:${relType}]${right}(b) RETURN ${projectNode("b")}, r.rel_type AS relationshipType`,
    params: { fromId: toInt(fromId) },
  }
}

/** Bounded variable-length traversal (HydraDB requires an explicit max hop count). */
export function traverseBounded(
  fromId: number,
  relType: string,
  direction: Direction,
  minHops: number,
  maxHops: number
): QuerySpec {
  assertIdentifier(relType, "relationship type")
  const { left, right } = directionArrows(direction)
  return {
    query: `MATCH (a {id: $fromId})${left}[:${relType}*${minHops}..${maxHops}]${right}(b) RETURN ${projectNode("b")} LIMIT 200`,
    params: { fromId: toInt(fromId) },
  }
}

export interface PathProcedureOptions {
  relTypes: string[]
  relDirection: Direction
  maxLen: number
  pathCount?: number
}

/**
 * Path-procedure config maps take relTypes/values as inline literals, not
 * `$parameters` — HydraDB rejects a list-valued parameter anywhere outside
 * an UNWIND input ("composite parameter is only supported as an UNWIND
 * input"). relType names are schema-controlled, but still identifier-checked
 * before being spliced into the query text.
 */
function relTypesLiteral(relTypes: string[]): string {
  return `[${relTypes.map((t) => `'${assertIdentifier(t, "relationship type")}'`).join(", ")}]`
}

/** `algo.SPpaths` — bounded paths between exactly one source and one target. */
export function shortestPaths(
  sourceId: number,
  targetId: number,
  opts: PathProcedureOptions
): QuerySpec {
  return {
    query: `CALL algo.SPpaths({sourceNode: $sourceId, targetNode: $targetId, relTypes: ${relTypesLiteral(opts.relTypes)}, relDirection: '${opts.relDirection}', maxLen: $maxLen, pathCount: $pathCount}) YIELD path, pathWeight, pathCost RETURN path, pathWeight, pathCost`,
    params: {
      sourceId: toInt(sourceId),
      targetId: toInt(targetId),
      maxLen: toInt(opts.maxLen),
      pathCount: toInt(opts.pathCount ?? 5),
    },
  }
}

/** `algo.SSpaths` — bounded paths from one source, useful for open-ended exploration. */
export function singleSourcePaths(
  sourceId: number,
  opts: PathProcedureOptions
): QuerySpec {
  return {
    query: `CALL algo.SSpaths({sourceNode: $sourceId, relTypes: ${relTypesLiteral(opts.relTypes)}, relDirection: '${opts.relDirection}', maxLen: $maxLen, pathCount: $pathCount}) YIELD path RETURN path`,
    params: {
      sourceId: toInt(sourceId),
      maxLen: toInt(opts.maxLen),
      pathCount: toInt(opts.pathCount ?? 20),
    },
  }
}

/**
 * Portable replacement for the `algo.SSpaths` expansion above: HydraDB Cloud
 * rejects every `CALL <procedure>` at parse time, so open-ended traversal has
 * to be expressed as plain pattern matching.
 *
 * One query covers a whole frontier of same-label ids via `UNWIND`, walks one
 * untyped hop in both directions, and filters on the app-level `rel_type`
 * property rather than the Cypher relationship type — so a caller can restrict
 * to a set of types without splicing N type names into the pattern (a pattern
 * takes one type per hop).
 *
 * Endpoints come back as `startNode(r).id` / `endNode(r).id` rather than being
 * inferred from the match direction, which keeps each edge's true orientation
 * even though the pattern is undirected. The neighbor is returned twice: as
 * `node` (the whole property bag) and as an explicit `nodeId` projection,
 * because the JSON renderer overwrites a returned node's `id` with the
 * collection-internal one — see `stripRendererKeys` in byog.ts.
 *
 * The frontier must be label-scoped: a labelless `MATCH (a {id: ...})` cannot
 * use the per-label id index and degrades into a full scan, which blows the
 * 8s read budget at corpus scale.
 */
export function expandNeighborhood(
  label: string,
  ids: number[],
  relTypes: string[],
  limit = 200
): QuerySpec {
  assertIdentifier(label, "label")
  return {
    query: `UNWIND $ids AS row MATCH (a:${label} {id: row.id})-[r]-(b) WHERE r.rel_type IN $relTypes RETURN startNode(r).id AS sourceId, endNode(r).id AS destinationId, r.id AS relId, r.rel_type AS relType, r AS rel, b.id AS nodeId, b.label AS nodeLabel, b.primary_text AS nodePrimaryText, b AS node LIMIT ${Math.max(1, Math.floor(limit))}`,
    params: { ids: ids.map((id) => ({ id: toInt(id) })), relTypes },
  }
}

/**
 * Every read Graf issues filters or joins on the app-level `id` property, so
 * without this index each one is a full label scan. At corpus scale that is the
 * difference between a 100ms query and blowing the server's execution budget —
 * create it per label *before* bulk loading, since the load itself is a stream
 * of `MERGE (n:Label {id: ...})`.
 */
export function createIdIndex(label: string): QuerySpec {
  assertIdentifier(label, "label")
  return { query: `CREATE INDEX FOR (n:${label}) ON (n.id)`, params: {} }
}

export interface UpsertNodeRow {
  id: number
  label: string
  primary_text: string
  [property: string]: string | number | boolean
}

export interface UpsertNodeOptions {
  /**
   * Put the label inside the MERGE pattern (`MERGE (n:Label {id})`) instead of
   * matching on id alone and adding the label with `SET n:Label`.
   *
   * The default (label out of the pattern) is what the self-hosted node's
   * Cypher subset accepts. Set this for HydraDB Cloud, where a labelless MERGE
   * cannot use the per-label id index from `createIdIndex` and turns every
   * batch in a 500k-node load into a full scan against a 30s write budget.
   */
  labelInMergePattern?: boolean
}

/** Batch upsert nodes. Every row must share the same property keys (dynamic SET from the first row's keys). */
export function upsertNodesBatch(
  label: string,
  rows: UpsertNodeRow[],
  opts: UpsertNodeOptions = {}
): QuerySpec {
  assertIdentifier(label, "label")
  if (rows.length === 0) throw new Error("upsertNodesBatch: rows is empty")
  const keys = Object.keys(rows[0]!).filter((k) => k !== "id")
  const setClause = keys
    .map((k) => `n.${assertIdentifier(k, "property")} = row.${k}`)
    .join(", ")
  const query = opts.labelInMergePattern
    ? `UNWIND $rows AS row MERGE (n:${label} {id: row.id}) SET ${setClause}`
    : `UNWIND $rows AS row MERGE (n {id: row.id}) SET n:${label}, ${setClause}`
  return {
    query,
    params: { rows: rows.map((row) => ({ ...row, id: toInt(row.id) })) },
  }
}

export interface UpsertRelationshipRow {
  id: number
  sourceId: number
  destinationId: number
  rel_type: string
  [property: string]: string | number | boolean
}

/**
 * Batch upsert relationships of one Cypher type between already-written
 * nodes. HydraDB's `UNWIND ... MATCH ... MERGE` batch form requires each
 * endpoint pattern to name exactly one label (unlike a plain single-row
 * MATCH, which can match on id alone) — so one batch can only cover a
 * single (sourceLabel, destinationLabel) pair. Split rows accordingly when
 * a relationship type connects more than one label pair.
 */
export function upsertRelationshipsBatch(
  relType: string,
  sourceLabel: string,
  destinationLabel: string,
  rows: UpsertRelationshipRow[]
): QuerySpec {
  assertIdentifier(relType, "relationship type")
  assertIdentifier(sourceLabel, "label")
  assertIdentifier(destinationLabel, "label")
  if (rows.length === 0)
    throw new Error("upsertRelationshipsBatch: rows is empty")
  const keys = Object.keys(rows[0]!).filter(
    (k) => k !== "id" && k !== "sourceId" && k !== "destinationId"
  )
  const setClause = keys
    .map((k) => `r.${assertIdentifier(k, "property")} = row.${k}`)
    .join(", ")
  return {
    query: `UNWIND $rows AS row MATCH (s:${sourceLabel} {id: row.sourceId}), (d:${destinationLabel} {id: row.destinationId}) MERGE (s)-[r:${relType} {id: row.id}]->(d) SET ${setClause}`,
    params: {
      rows: rows.map((row) => ({
        ...row,
        id: toInt(row.id),
        sourceId: toInt(row.sourceId),
        destinationId: toInt(row.destinationId),
      })),
    },
  }
}

/**
 * HydraDB's Cypher subset has no catalog procedures, and a bare `MATCH (n)`
 * full scan is rejected outright ("node-only MATCH requires an id, label, or
 * property predicate") — so there is no way to enumerate labels/relationship
 * types/property keys that Graf wasn't already told about. GraphSchema (see
 * @workspace/graph-schema) is therefore the only source of truth for what a
 * HydraDB graph contains; the best Graf can do at runtime is *probe* whether
 * each schema-declared label/relationship type actually has data, one query
 * per candidate since labels/types can't be parameterized.
 */
/**
 * Splits rows into batches bounded by *measured serialized bytes*, not row
 * count. Both transports cap the request, not the row count — 2 MiB for Bolt,
 * 256 KiB for HydraDB Cloud — and once node properties carry full document
 * bodies, row size varies by three orders of magnitude between a Person (a
 * name) and a Confluence page (kilobytes of text). Any fixed row count is
 * therefore either far too small for the small rows or fatally too large for
 * the big ones; a full-corpus load died exactly this way.
 *
 * `maxRows` is a secondary ceiling so a batch of tiny rows still finishes
 * inside the server's write budget, and a single row over `maxBytes` is emitted
 * alone rather than dropped — truncating oversized *properties* is the caller's
 * job (see `truncateProperties`), because a row that can never fit would
 * otherwise retry forever.
 */
export function chunkRowsBySize<T>(
  rows: T[],
  maxBytes: number,
  maxRows: number
): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let currentBytes = 0
  for (const row of rows) {
    // +1 for the comma this row adds to the serialized array.
    const size = JSON.stringify(row).length + 1
    if (current.length > 0 && (currentBytes + size > maxBytes || current.length >= maxRows)) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(row)
    currentBytes += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Caps each string property at `maxChars`. A single pathological document can
 * exceed a transport's whole request cap on its own, and no batching strategy
 * can rescue a row that never fits — it has to be shortened or it can never be
 * written at all. Truncation is marked so a reader can tell a clipped body from
 * a genuinely short one.
 */
export function truncateProperties<T extends Record<string, string | number | boolean>>(
  row: T,
  maxChars: number
): T {
  let out: T | undefined
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string" || value.length <= maxChars) continue
    out ??= { ...row }
    ;(out as Record<string, string | number | boolean>)[key] =
      `${value.slice(0, maxChars)}… [truncated ${value.length - maxChars} chars]`
  }
  return out ?? row
}

export function probeLabelCount(label: string): QuerySpec {
  assertIdentifier(label, "label")
  return { query: `MATCH (n:${label}) RETURN count(*) AS count`, params: {} }
}

export function probeRelTypeCount(relType: string): QuerySpec {
  assertIdentifier(relType, "relationship type")
  return {
    query: `MATCH ()-[r:${relType}]->() RETURN count(*) AS count`,
    params: {},
  }
}

/**
 * Lists every node of one label, up to `limit`. A bare `MATCH (n:Label)` is
 * allowed (the label counts as the required match predicate) — used as the
 * candidate pool for entity resolution since the Cypher subset has no
 * CONTAINS/fuzzy text matching, so ranking mentions against a small labeled
 * pool is done in the LLM/vector layer instead of in the query itself.
 */
export function listNodesByLabel(
  label: string,
  limit: number,
  schemaEntry?: NodeLabelSchema
): QuerySpec {
  assertIdentifier(label, "label")
  const extra = schemaEntry?.properties.map((p) => p.name) ?? []
  return {
    query: `MATCH (n:${label}) RETURN ${projectNode("n", extra)} LIMIT ${Math.max(1, Math.floor(limit))}`,
    params: {},
  }
}
