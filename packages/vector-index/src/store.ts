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
  vector: number[] | Float32Array
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
  labels?: string[]
}

interface StoredVector {
  id: number
  label: string
  primaryText: string
  vector: Float32Array
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

function siblingPaths(path: string): { metaPath: string; vectorsPath: string } {
  const base = path.replace(/\.json$/, "")
  return { metaPath: `${base}.meta.jsonl`, vectorsPath: `${base}.vectors.bin` }
}

export class VectorIndex {
  private entries: StoredVector[] = []
  // id -> index into `entries`, so upsert/lookup is O(1) instead of a linear
  // scan — at full-corpus scale (500k+ entries) a per-item findIndex() during
  // a batch upsert is O(n^2) and never finishes.
  private byId = new Map<number, number>()

  upsert(entries: IndexedVector[]): void {
    for (const entry of entries) {
      const vector = entry.vector instanceof Float32Array ? entry.vector : Float32Array.from(entry.vector)
      const stored: StoredVector = { id: entry.id, label: entry.label, primaryText: entry.primaryText, vector }
      const existingIndex = this.byId.get(entry.id)
      if (existingIndex !== undefined) {
        this.entries[existingIndex] = stored
      } else {
        this.byId.set(entry.id, this.entries.length)
        this.entries.push(stored)
      }
    }
  }

  private scoreEntries(queryVector: Float32Array, candidates: StoredVector[], topK: number): VectorMatch[] {
    return candidates
      .map((entry) => ({ id: entry.id, label: entry.label, primaryText: entry.primaryText, score: cosineSimilarity(queryVector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  search(queryVector: number[], opts: VectorIndexQuery = {}): VectorMatch[] {
    const topK = opts.topK ?? 10
    const q = Float32Array.from(queryVector)
    const labels = opts.labels ?? (opts.label ? [opts.label] : undefined)
    const candidates = labels ? this.entries.filter((e) => labels.includes(e.label)) : this.entries
    return this.scoreEntries(q, candidates, topK)
  }

  /**
   * Scores only the given ids instead of the whole index — O(ids.length)
   * instead of O(size()). Use this whenever the caller already knows which
   * nodes it cares about (e.g. re-ranking the handful of nodes a graph
   * traversal touched) instead of searching the full corpus for them.
   */
  searchAmong(queryVector: number[], ids: number[], topK: number = ids.length): VectorMatch[] {
    const q = Float32Array.from(queryVector)
    const candidates: StoredVector[] = []
    for (const id of ids) {
      const idx = this.byId.get(id)
      if (idx !== undefined) candidates.push(this.entries[idx]!)
    }
    return this.scoreEntries(q, candidates, topK)
  }

  size(): number {
    return this.entries.length
  }

  hasId(id: number): boolean {
    return this.byId.has(id)
  }

  /**
   * Splits storage into a small metadata sidecar (JSONL: id/label/primaryText,
   * one per line) and one binary blob of raw float32 vectors. A plain JSON
   * array of ~500k 1024-dim vectors would serialize to double-digit GB of
   * text (each float costs ~18 bytes as JSON) — binary float32 is ~4-5x
   * smaller and avoids ever building a JSON string anywhere near V8's
   * string-length ceiling.
   */
  save(path: string): void {
    const { metaPath, vectorsPath } = siblingPaths(path)
    const dim = this.entries[0]?.vector.length ?? 0
    const vectorsBuffer = Buffer.alloc(this.entries.length * dim * 4)
    let metaLines = ""
    this.entries.forEach((entry, i) => {
      metaLines += `${JSON.stringify({ id: entry.id, label: entry.label, primaryText: entry.primaryText })}\n`
      Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength).copy(vectorsBuffer, i * dim * 4)
    })
    writeFileSync(metaPath, metaLines, "utf-8")
    writeFileSync(vectorsPath, vectorsBuffer)
    writeFileSync(path, JSON.stringify({ count: this.entries.length, dim }), "utf-8")
  }

  load(path: string): void {
    if (!existsSync(path)) return
    const { metaPath, vectorsPath } = siblingPaths(path)
    if (!existsSync(metaPath) || !existsSync(vectorsPath)) return
    const { dim } = JSON.parse(readFileSync(path, "utf-8")) as { count: number; dim: number }
    const metaLines = readFileSync(metaPath, "utf-8").split("\n").filter(Boolean)
    const vectorsBuffer = readFileSync(vectorsPath)
    this.entries = []
    this.byId.clear()
    metaLines.forEach((line, i) => {
      const meta = JSON.parse(line) as { id: number; label: string; primaryText: string }
      const vector = new Float32Array(vectorsBuffer.buffer, vectorsBuffer.byteOffset + i * dim * 4, dim)
      this.byId.set(meta.id, this.entries.length)
      this.entries.push({ ...meta, vector })
    })
  }
}

export function loadVectorIndex(path: string): VectorIndex {
  const index = new VectorIndex()
  index.load(path)
  return index
}
