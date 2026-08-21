import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"

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
  /**
   * ‖vector‖, cached at insert/load. An entry's own norm never changes, so
   * recomputing it on every search is pure waste — and search is where the
   * whole corpus gets touched.
   */
  norm: number
}

function norm(v: Float32Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!
    sum += x * x
  }
  return Math.sqrt(sum)
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}

/**
 * Min-heap over (score, candidate index), used to take the top K in one pass.
 *
 * The obvious implementation — score everything into an array of objects, sort,
 * slice — allocates one object per entry and sorts the whole corpus on every
 * search, to then throw away all but K. This keeps allocation and ordering work
 * proportional to K instead of n.
 *
 * Worth being honest about the size of the win: measured over 200k entries,
 * this plus cached norms took a full search from 306ms to 247ms (~950ms
 * projected at 772k, down from ~1.2s) — real, but not the order of magnitude
 * the removed work suggests. At 1024 float32 dimensions the scan streams ~3.2GB
 * of vector data at full corpus scale, so search is memory-bandwidth bound, and
 * arithmetic saved off the inner loop is largely hidden behind the load. Making
 * this meaningfully faster means scanning fewer bytes (quantization, or an ANN
 * structure), not fewer operations.
 */
class TopK {
  private scores: Float64Array
  private indexes: Int32Array
  private size = 0

  constructor(private capacity: number) {
    this.scores = new Float64Array(capacity)
    this.indexes = new Int32Array(capacity)
  }

  offer(score: number, index: number): void {
    if (this.size < this.capacity) {
      this.scores[this.size] = score
      this.indexes[this.size] = index
      this.size++
      this.siftUp(this.size - 1)
      return
    }
    if (score <= this.scores[0]!) return
    this.scores[0] = score
    this.indexes[0] = index
    this.siftDown(0)
  }

  /** Highest score first. */
  drain(): { score: number; index: number }[] {
    const out: { score: number; index: number }[] = []
    for (let i = 0; i < this.size; i++) out.push({ score: this.scores[i]!, index: this.indexes[i]! })
    return out.sort((a, b) => b.score - a.score)
  }

  private swap(i: number, j: number): void {
    const s = this.scores[i]!
    this.scores[i] = this.scores[j]!
    this.scores[j] = s
    const x = this.indexes[i]!
    this.indexes[i] = this.indexes[j]!
    this.indexes[j] = x
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.scores[parent]! <= this.scores[i]!) break
      this.swap(parent, i)
      i = parent
    }
  }

  private siftDown(i: number): void {
    for (;;) {
      const left = i * 2 + 1
      const right = left + 1
      let smallest = i
      if (left < this.size && this.scores[left]! < this.scores[smallest]!) smallest = left
      if (right < this.size && this.scores[right]! < this.scores[smallest]!) smallest = right
      if (smallest === i) return
      this.swap(i, smallest)
      i = smallest
    }
  }
}

function siblingPaths(path: string): { metaPath: string; vectorsPath: string } {
  const base = path.replace(/\.json$/, "")
  return { metaPath: `${base}.meta.jsonl`, vectorsPath: `${base}.vectors.bin` }
}

/** 512 MiB. Any value under 2 GiB works; this one keeps the loop short. */
const READ_CHUNK_BYTES = 512 * 1024 * 1024

/**
 * `readFileSync` refuses anything over 2 GiB — not a memory limit but a cap on
 * the single buffer it allocates internally — and the full corpus is ~3.2 GB
 * (772k × 1024 × float32). So allocate the destination up front and fill it
 * with positioned reads.
 *
 * It has to be one allocation rather than a list of chunks: every entry's
 * vector is a zero-copy Float32Array view into this buffer, and a view can't
 * straddle two of them. `ArrayBuffer` has no 2 GiB ceiling of its own, so the
 * cap only ever applied to how the bytes were fetched.
 */
function readLargeFile(path: string): ArrayBuffer {
  const byteLength = statSync(path).size
  const buffer = new ArrayBuffer(byteLength)
  // Zero-copy window onto `buffer`, because readSync only writes into a Buffer.
  const window = Buffer.from(buffer)
  const fd = openSync(path, "r")
  try {
    let offset = 0
    while (offset < byteLength) {
      const read = readSync(fd, window, offset, Math.min(READ_CHUNK_BYTES, byteLength - offset), offset)
      // A short read before EOF is legal; zero bytes means the file ended early.
      if (read === 0) throw new Error(`${path}: expected ${byteLength} bytes, file ended at ${offset}`)
      offset += read
    }
  } finally {
    closeSync(fd)
  }
  return buffer
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
      const stored: StoredVector = { id: entry.id, label: entry.label, primaryText: entry.primaryText, vector, norm: norm(vector) }
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
    const queryNorm = norm(queryVector)
    if (queryNorm === 0) return []
    const heap = new TopK(Math.max(Math.min(topK, candidates.length), 0))
    for (let i = 0; i < candidates.length; i++) {
      const entry = candidates[i]!
      const score = entry.norm === 0 ? 0 : dotProduct(queryVector, entry.vector) / (queryNorm * entry.norm)
      heap.offer(score, i)
    }
    return heap.drain().map(({ score, index }) => {
      const entry = candidates[index]!
      return { id: entry.id, label: entry.label, primaryText: entry.primaryText, score }
    })
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
    const vectorsBuffer = readLargeFile(vectorsPath)
    this.entries = []
    this.byId.clear()
    metaLines.forEach((line, i) => {
      const meta = JSON.parse(line) as { id: number; label: string; primaryText: string }
      const vector = new Float32Array(vectorsBuffer, i * dim * 4, dim)
      this.byId.set(meta.id, this.entries.length)
      this.entries.push({ ...meta, vector, norm: norm(vector) })
    })
  }
}

export function loadVectorIndex(path: string): VectorIndex {
  const index = new VectorIndex()
  index.load(path)
  return index
}
