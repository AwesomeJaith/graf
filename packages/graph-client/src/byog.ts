import neo4j from "neo4j-driver"
import type { QuerySpec } from "./cypher"

/**
 * HydraDB Cloud "Bring Your Own Graph" transport.
 *
 * The managed service exposes two unrelated surfaces: a turnkey RAG API
 * (`/context/ingest` + `/query`, which owns its own extraction and schema)
 * and BYOG (`/byog/query`), which is a plain openCypher endpoint over graph
 * collections we model ourselves. Graf uses BYOG — the whole point of this
 * project is that the graph *is* the retrieval mechanism, so a service that
 * decides the ontology for us is the wrong half of the product.
 *
 * Differences from the self-hosted node in client.ts/http.ts that callers
 * actually have to care about:
 *
 * - **No procedure calls.** `CALL algo.SPpaths/SSpaths` is rejected at parse
 *   time with a 400. Traversal goes through variable-length patterns and
 *   `startNode`/`endNode` projections instead — see `expandNeighborhood` in
 *   cypher.ts.
 * - **256 KiB request bodies** (vs. 2 MiB for Bolt), enforced with a 413. Write
 *   batches must be sized by measured serialized bytes, not row count.
 * - **Richer Cypher otherwise**: `IN`, `CONTAINS`, `count(*)`, and untyped
 *   `-[r]-` patterns all work here and are rejected by the self-hosted subset.
 * - **Plain JSON parameters** — there is no Bolt Integer type on the wire, so
 *   the `neo4j.int()` wrapping that cypher.ts applies for the Bolt path has to
 *   be unwrapped again on the way out.
 */

const DEFAULT_BASE_URL = "https://api.hydradb.com"

export interface ByogConfig {
  baseUrl: string
  apiKey: string
  database: string
  collection: string
}

export function loadByogConfig(env: NodeJS.ProcessEnv = process.env): ByogConfig {
  const apiKey = env.HYDRA_DB_API_KEY
  if (!apiKey) {
    throw new Error(
      "HYDRA_DB_API_KEY is not set. It is required for the HydraDB Cloud BYOG transport (GRAF_GRAPH_TRANSPORT=byog)."
    )
  }
  return {
    baseUrl: env.HYDRADB_CLOUD_URL ?? DEFAULT_BASE_URL,
    apiKey,
    database: env.HYDRADB_BYOG_DATABASE ?? "graf",
    collection: env.HYDRADB_BYOG_COLLECTION ?? "bench_full",
  }
}

/** True when the app/scripts should talk to HydraDB Cloud rather than a local node. */
export function isByogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GRAF_GRAPH_TRANSPORT === "byog"
}

/**
 * cypher.ts wraps every id-shaped parameter in `neo4j.int()` because the Bolt
 * transport sends plain JS numbers as Float and the self-hosted node rejects a
 * Float id. Over JSON that wrapper would serialize as `{low, high}`, so it has
 * to come back off here.
 */
function toPlainParam(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (neo4j.isInt(value)) return value.toNumber()
  if (Array.isArray(value)) return value.map(toPlainParam)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlainParam(v)])
    )
  }
  return value
}

/** The renderer adds these to any returned node/relationship, shadowing a stored property of the same name. */
const RENDERER_KEYS = ["id", "labels", "relation", "source_node_id", "target_node_id"] as const

/**
 * Strips the keys HydraDB's JSON renderer injects into a returned node or
 * relationship. Graf stores its own `id` as a real property, and the renderer
 * overwrites it in the response with the collection-internal id — which is not
 * stable across collections and is not what anything downstream keys on. Always
 * read the app id from an explicit `n.id AS ...` projection and use this to get
 * a clean property bag.
 */
export function stripRendererKeys(
  node: Record<string, unknown> | undefined
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(node ?? {})) {
    if ((RENDERER_KEYS as readonly string[]).includes(key)) continue
    if (value === null || value === undefined) continue
    out[key] = value as string | number | boolean
  }
  return out
}

export class ByogError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string
  ) {
    super(message)
    this.name = "ByogError"
  }

  /** 429/500 are documented as transient and safe to retry; 400/403/404/413 are not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ByogRunOptions {
  config?: ByogConfig
  /** Retries apply to 429/5xx and network errors only. */
  maxAttempts?: number
  collection?: string
}

/**
 * Runs one Cypher statement against a BYOG collection and returns plain-object
 * rows keyed by RETURN alias. Unlike the Bolt transport there is nothing to
 * unwrap — values arrive as ordinary JSON — except returned node/relationship
 * objects, whose injected keys `stripRendererKeys` handles.
 */
export async function runQueryByog(
  query: string,
  params: Record<string, unknown> = {},
  opts: ByogRunOptions = {}
): Promise<Record<string, unknown>[]> {
  const config = opts.config ?? loadByogConfig()
  const collection = opts.collection ?? config.collection
  const maxAttempts = opts.maxAttempts ?? 5
  const body = JSON.stringify({
    database: config.database,
    collection,
    query,
    params: toPlainParam(params),
  })

  let attempt = 0
  for (;;) {
    attempt++
    try {
      const response = await fetch(`${config.baseUrl}/byog/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      })
      const payload = (await response.json().catch(() => ({}))) as {
        data?: Record<string, unknown>[]
        detail?: { message?: string; error_code?: string }
        error?: { message?: string }
      }
      if (!response.ok) {
        const detail = payload.detail
        throw new ByogError(
          detail?.message ?? payload.error?.message ?? `HydraDB BYOG query failed with status ${response.status}`,
          response.status,
          detail?.error_code
        )
      }
      // A pure write with no RETURN legitimately yields `data: []`.
      return payload.data ?? []
    } catch (err) {
      const retryable = err instanceof ByogError ? err.retryable : true
      if (!retryable || attempt >= maxAttempts) throw err
      // Exponential backoff with a fixed jitter offset per attempt; the cap
      // keeps a long unattended ingest from stalling for minutes on one batch.
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000) + attempt * 137)
    }
  }
}

export async function runWritesByog(
  statements: QuerySpec[],
  opts: ByogRunOptions = {}
): Promise<void> {
  for (const statement of statements) {
    await runQueryByog(statement.query, statement.params ?? {}, opts)
  }
}

export async function createByogDatabase(opts: ByogRunOptions = {}): Promise<void> {
  const config = opts.config ?? loadByogConfig()
  const response = await fetch(`${config.baseUrl}/byog/databases`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ database: config.database }),
  })
  // 409 means it already exists, which is the desired end state either way.
  if (!response.ok && response.status !== 409) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: { message?: string } }
    throw new ByogError(
      payload.detail?.message ?? `Creating BYOG database failed with status ${response.status}`,
      response.status
    )
  }
}
