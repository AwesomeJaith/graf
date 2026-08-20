import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadContentStore, type ContentStore } from "@workspace/vector-index"

import type { TraceNode } from "./types"

const __dirname = dirname(fileURLToPath(import.meta.url))
const VECTOR_INDEX_PATH = process.env.VECTOR_INDEX_PATH ?? join(__dirname, "..", "..", "bench", "data", "vector-index.sample.json")

/**
 * Property name the body text is merged back in under. Downstream consumers
 * (answer synthesis, the graph trace, the document viewer) read node properties
 * generically, so a single well-known key is enough — nothing needs to know
 * whether the text came from the graph or the sidecar.
 */
export const BODY_PROPERTY = "content"

let store: ContentStore | null | undefined

/**
 * Loaded lazily and cached, including the negative case: a deployment pointed at
 * a graph that stores its own bodies (the committed sample, or any other HydraDB
 * instance) has no sidecar, and must not pay a filesystem check per request.
 */
function getStore(): ContentStore | undefined {
  if (store === undefined) store = loadContentStore(VECTOR_INDEX_PATH) ?? null
  return store ?? undefined
}

/**
 * Merges body text from the local content sidecar into nodes that don't already
 * carry it.
 *
 * At full-corpus scale document bodies are not stored in the graph at all — they
 * exhausted the cloud instance's memory, and the graph never queries them (see
 * ContentStore). They're re-attached here, after traversal, so everything
 * downstream sees the same node shape it always did.
 *
 * Nodes that already have body text win: the sample corpus and the demo graph
 * do store it inline, and this must not clobber them.
 */
export function attachBodyText<T extends TraceNode>(nodes: T[]): T[] {
  const contentStore = getStore()
  if (!contentStore) return nodes
  return nodes.map((node) => {
    const existing = node.properties[BODY_PROPERTY]
    if (typeof existing === "string" && existing.length > 0) return node
    const text = contentStore.get(node.id)
    if (!text) return node
    return { ...node, properties: { ...node.properties, [BODY_PROPERTY]: text } }
  })
}
