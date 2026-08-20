import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { getNodeById, runQueryHttp } from "@workspace/graph-client"
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
  const results: ResolvedNode[] = []
  for (const match of matches) {
    const schemaEntry = findNodeLabel(schema, match.label)
    const spec = getNodeById(match.label, match.id, schemaEntry)
    try {
      const rows = await runQueryHttp(spec.query, spec.params)
      const row = rows[0]
      if (!row) continue
      const { id: _id, label: rowLabel, primary_text, ...rest } = row
      results.push({
        id: match.id,
        label: (rowLabel as string) ?? match.label,
        primaryText: (primary_text as string) ?? match.primaryText,
        properties: rest as ResolvedNode["properties"],
      })
    } catch {
      continue
    }
  }
  return results
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

  const ranked = index.search(queryVector, { topK: index.size() })
  const rankPosition = new Map(ranked.map((m, i) => [m.id, i]))

  const withEmbedding = candidateIds.filter((id) => rankPosition.has(id))
  const withoutEmbedding = candidateIds.filter((id) => !rankPosition.has(id))
  withEmbedding.sort((a, b) => rankPosition.get(a)! - rankPosition.get(b)!)

  return new Set([...withEmbedding.slice(0, topK), ...withoutEmbedding])
}
