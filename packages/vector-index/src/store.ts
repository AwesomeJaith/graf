import { existsSync, readFileSync, writeFileSync } from "node:fs"

/**
 * HydraDB has no native vector/fulltext search (see cypher-compat.md), so
 * semantic candidate generation for entity resolution runs through this
 * sidecar: embeddings keyed by graph node id, brute-force cosine at demo
 * scale. Graph traversal stays the primary retrieval mechanism — this only
 * seeds/re-ranks entity candidates, it never replaces traversal.
 */
export interface IndexedVector {
  id: number
  label: string
  primaryText: string
  vector: number[]
}

export interface VectorMatch {
  id: number
  label: string
  primaryText: string
  score: number
}

export interface VectorIndexQuery {
  topK?: number
  label?: string
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export class VectorIndex {
  private entries: IndexedVector[] = []

  upsert(entries: IndexedVector[]): void {
    for (const entry of entries) {
      const existingIndex = this.entries.findIndex((e) => e.id === entry.id)
      if (existingIndex >= 0) this.entries[existingIndex] = entry
      else this.entries.push(entry)
    }
  }

  search(queryVector: number[], opts: VectorIndexQuery = {}): VectorMatch[] {
    const topK = opts.topK ?? 10
    const candidates = opts.label
      ? this.entries.filter((e) => e.label === opts.label)
      : this.entries
    return candidates
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        primaryText: entry.primaryText,
        score: cosineSimilarity(queryVector, entry.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  size(): number {
    return this.entries.length
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.entries), "utf-8")
  }

  load(path: string): void {
    if (!existsSync(path)) return
    this.entries = JSON.parse(readFileSync(path, "utf-8")) as IndexedVector[]
  }
}

export function loadVectorIndex(path: string): VectorIndex {
  const index = new VectorIndex()
  index.load(path)
  return index
}
