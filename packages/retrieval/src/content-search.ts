import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { getNodesByIdBatch, runGraphQuery } from "@workspace/graph-client"
import { findNodeLabel, loadGraphSchema, type GraphSchema } from "@workspace/graph-schema"
import { embedText, VectorIndex } from "@workspace/vector-index"

import type { ResolvedNode } from "./types"

const __dirname = dirname(fileURLToPath(import.meta.url))
const VECTOR_INDEX_PATH = process.env.VECTOR_INDEX_PATH ?? join(__dirname, "..", "..", "bench", "data", "vector-index.sample.json")

let cachedIndex: VectorIndex | undefined
function loadIndex(): VectorIndex {
  if (!cachedIndex) {
    cachedIndex = new VectorIndex()
    cachedIndex.load(VECTOR_INDEX_PATH)
  }
  return cachedIndex
}

/**
 * Fetches full node detail for a set of vector matches, one query per distinct
 * label rather than one per match. The index only stores id/label/primaryText,
 * so every match needs a graph read to get its real properties — and against
 * HydraDB Cloud each read is a ~100ms round trip, so hydrating 20 candidates
 * serially cost two seconds of every question's latency on its own. Matches are
 * returned in the index's relevance order, not the graph's row order.
 */
async function hydrate(matches: { id: number; label: string; primaryText: string }[], schema: GraphSchema): Promise<ResolvedNode[]> {
  const byLabel = new Map<string, number[]>()
  for (const match of matches) {
    const list = byLabel.get(match.label) ?? []
    list.push(match.id)
    byLabel.set(match.label, list)
  }

  const hydrated = new Map<number, ResolvedNode>()
  await Promise.all(
    Array.from(byLabel.entries()).map(async ([label, ids]) => {
      const spec = getNodesByIdBatch(label, ids, findNodeLabel(schema, label))
      try {
        for (const row of await runGraphQuery(spec.query, spec.params)) {
          const { id, label: rowLabel, primary_text, ...rest } = row
          if (typeof id !== "number") continue
          hydrated.set(id, {
            id,
            label: (rowLabel as string) ?? label,
            primaryText: (primary_text as string) ?? "",
            properties: rest as ResolvedNode["properties"],
          })
        }
      } catch {
        // A label with no rows (or a transport error on one label) shouldn't
        // drop the matches found under every other label.
      }
    })
  )

  return matches
    .map((match) => hydrated.get(match.id))
    .filter((node): node is ResolvedNode => node !== undefined)
}

/**
 * Semantic entry point into content nodes (Document/Message/Task/Issue)
 * that named-entity resolution alone can't reach — most factual questions
 * ("what are the default size limits for...") don't mention a Person or
 * Project at all. Runs alongside entity resolution, not instead of it: this
 * finds *what*, entity resolution finds *who*, graph traversal connects them.
 */
export async function searchContent(question: string, schema: GraphSchema, topK = 5, minScore = 0.4): Promise<ResolvedNode[]> {
  const index = loadIndex()
  if (index.size() === 0) return []

  let queryVector: number[]
  try {
    queryVector = await embedText(question)
  } catch {
    return []
  }

  // Below ~0.4 cosine, matches are coincidental (a shared word, a name
  // fragment) rather than genuinely relevant — without a floor, every
  // question pulls in a handful of unrelated nodes and their traversal
  // neighborhoods, burying the real answer under noise in the trace.
  // (Callers doing interactive search-as-you-type, e.g. @mentions, pass a
  // much lower floor since a short partial query embeds less confidently.)
  const matches = index.search(queryVector, { topK }).filter((m) => m.score >= minScore)
  return hydrate(matches, schema)
}

/**
 * Semantic candidate lookup for a specific mention, restricted to the label(s)
 * it could plausibly be. Entity resolution used to pull an unfiltered,
 * arbitrary `LIMIT 50` slice of an entire label — fine when a label has a few
 * dozen rows total, useless once a label has tens/hundreds of thousands (the
 * real match is very unlikely to be in an arbitrary unordered 50-row slice).
 * Searching the embedding index by the mention text itself scales with corpus
 * size instead of breaking past it.
 */
export async function searchCandidatesByLabel(mentionText: string, labels: string[], schema: GraphSchema, topK = 20): Promise<ResolvedNode[]> {
  const index = loadIndex()
  if (index.size() === 0 || labels.length === 0) return []

  let queryVector: number[]
  try {
    queryVector = await embedText(mentionText)
  } catch {
    return []
  }

  const matches = index.search(queryVector, { topK, labels })
  return hydrate(matches, schema)
}

export interface MentionCandidate {
  id: number
  label: string
  name: string
  subtitle?: string
}

function subtitleFor(node: ResolvedNode): string | undefined {
  const value = node.properties.title ?? node.properties.name ?? node.properties.summary ?? node.properties.status
  return typeof value === "string" && value !== node.primaryText ? value : undefined
}

/**
 * Powers "@" mention search-as-you-type in the chat input — same semantic
 * index as searchContent, but a much lower relevance floor (a two-letter
 * partial name embeds nowhere near as confidently as a full sentence) and a
 * shape suited to an autocomplete list rather than retrieval evidence.
 */
export async function searchMentions(query: string, topK = 8): Promise<MentionCandidate[]> {
  if (!query.trim()) return []
  const nodes = await searchContent(query, loadGraphSchema(), topK, 0.15)
  return nodes.map((n) => ({ id: n.id, label: n.label, name: n.primaryText, subtitle: subtitleFor(n) }))
}

/**
 * Ranks candidate node ids by relevance to the question using the same
 * precomputed embeddings, and returns only the top `topK` — the answer
 * synthesis prompt otherwise gets every node a 3-hop traversal touched
 * (mostly structural: a shared Person/Project on the way to the real
 * answer), which dilutes precision on exact figures/names. Ids with no
 * embedding in the index (non-content nodes — Person/Project/Organization,
 * or hand-authored demo nodes) pass through unfiltered; they're not the
 * noise source and there are always few of them.
 */
export async function rankNodeIdsByRelevance(question: string, candidateIds: number[], topK: number): Promise<Set<number>> {
  const index = loadIndex()
  const unranked = new Set(candidateIds)
  if (index.size() === 0) return unranked

  let queryVector: number[]
  try {
    queryVector = await embedText(question)
  } catch {
    return unranked
  }

  // Score only the ids the traversal actually touched instead of the whole
  // index — at full-corpus scale (500k+ embedded entities) sorting the
  // entire index just to filter it back down to a few dozen candidates is
  // by far the most expensive step in the request for no benefit.
  const ranked = index.searchAmong(queryVector, candidateIds, candidateIds.length)
  const rankPosition = new Map(ranked.map((m, i) => [m.id, i]))

  const withEmbedding = candidateIds.filter((id) => rankPosition.has(id))
  const withoutEmbedding = candidateIds.filter((id) => !rankPosition.has(id))
  withEmbedding.sort((a, b) => rankPosition.get(a)! - rankPosition.get(b)!)

  return new Set([...withEmbedding.slice(0, topK), ...withoutEmbedding])
}
