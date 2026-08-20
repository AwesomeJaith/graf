import { isByogEnabled, runQueryByog } from "./byog"
import { runQueryHttp } from "./http"

/**
 * The single read entry point for the live app.
 *
 * Graf can point at either a self-hosted HydraDB node or a HydraDB Cloud BYOG
 * collection, and the two speak different wire protocols (local JSON-over-HTTP
 * with tagged property values vs. the cloud's plain-JSON envelope). Everything
 * above this line works in terms of `QuerySpec` + plain row objects and does
 * not care which is live, so switching deployments is one env var —
 * `GRAF_GRAPH_TRANSPORT=byog` — rather than a code change.
 *
 * Writes deliberately do not go through here: the local node needs Bolt for
 * batched `UNWIND` writes (see cypher-compat.md) while the cloud has no Bolt
 * endpoint at all, so ingestion scripts pick their transport explicitly.
 */
export function runGraphQuery(
  query: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>[]> {
  return isByogEnabled() ? runQueryByog(query, params) : runQueryHttp(query, params)
}

/** Names the active read transport, for startup logs and the eval harness's run metadata. */
export function activeGraphTransport(): "byog" | "http" {
  return isByogEnabled() ? "byog" : "http"
}
