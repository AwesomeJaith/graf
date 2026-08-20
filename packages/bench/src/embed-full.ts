import "dotenv/config"
import {
  closeSync,
  createReadStream,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createInterface } from "node:readline"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { embedText, loadEmbeddingConfig } from "@workspace/vector-index"

/**
 * Embeds the queue written by ingest-full.ts into a vector-index sidecar.
 *
 * Split out of ingestion for two reasons: the graph is useful the moment it
 * lands (minutes) while this pass takes hours at half a million nodes, and an
 * embedding run that dies at 80% must not cost the graph load.
 *
 * It also writes the sidecar *append-only* rather than going through
 * VectorIndex.save(). That method serializes the entire index on every call,
 * which is the right trade at sample scale but not here: 500k+ 1024-dim vectors
 * is a ~2 GB blob, so checkpointing every N items would spend more wall-clock
 * rewriting the same bytes than calling Bedrock. Appending makes a checkpoint
 * cost O(new rows) and caps this process's own memory at the resume-set of ids.
 * The on-disk layout is byte-identical to what VectorIndex.load() expects —
 * descriptor JSON + `.meta.jsonl` + packed float32 `.vectors.bin`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORK_DIR = process.env.BENCH_WORK_DIR ?? join(__dirname, "..", "data", "full-ingest")
const QUEUE_PATH = join(WORK_DIR, "embed-queue.jsonl")
const INDEX_PATH = process.env.VECTOR_INDEX_FULL_PATH ?? join(__dirname, "..", "data", "vector-index.full.json")

/**
 * Requests in flight at once. This job is entirely Bedrock-bound — the process
 * sits at under half of one core and 0.2 GB — so nothing about the machine it
 * runs on sets throughput. A bigger box does not make this faster.
 *
 * 64 is where the account's embedding throughput saturates, and it's worth
 * recording how that was established, because the obvious explanation was
 * wrong. At 64 in flight the job holds 80-95/s, i.e. ~700ms per slot, which is
 * far longer than a single call really takes. That looked like the lockstep
 * batch barrier the pool below replaced — every slot idling until the slowest
 * call in its batch returned. It wasn't: measured across ~400k calls, lockstep
 * batches and the continuously-refilled pool run at the same rate, and the
 * remaining ~700ms is Bedrock queueing the request account-side. AWS spends the
 * quota on latency before it spends it on errors, so saturation shows up as
 * slower calls first and ThrottlingException only at the edge.
 *
 * The practical consequence: raising this number buys nothing and eventually
 * costs. Throttles begin appearing at this rate, and past the quota extra
 * concurrency converts throughput into retries. If throughput actually matters,
 * the lever is a quota increase or a second region, not a larger pool.
 *
 * Throttles that do land are routine rather than fatal: embedWithRetry backs
 * off exponentially, and anything that still fails is simply absent from the
 * sidecar and picked up by re-running (loadResumeState skips what's present).
 */
const CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? 64)
const FLUSH_EVERY = 2_000
const MAX_ATTEMPTS = 6

/**
 * Retries throttled/transient Bedrock calls with exponential backoff.
 *
 * Embedding three quarters of a million texts runs well above the account's
 * steady-state request quota, so ThrottlingException is an expected, routine
 * response rather than an error — without a retry every throttle would silently
 * leave a node unembedded (and therefore unreachable by semantic search) until
 * someone noticed the count was short. Validation errors are not retried: a text
 * the model rejects will be rejected identically six times.
 */
async function embedWithRetry(text: string, config: Parameters<typeof embedText>[1]): Promise<number[]> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await embedText(text, config)
    } catch (err) {
      lastError = err as Error
      const name = (err as { name?: string }).name ?? ""
      const retryable = /Throttling|TooManyRequests|ServiceUnavailable|InternalServer|Timeout|ECONNRESET/i.test(
        `${name} ${lastError.message}`
      )
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError
      const delay = Math.min(1000 * 2 ** (attempt - 1), 20_000) + attempt * 173
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError ?? new Error("embed failed")
}

interface QueueItem {
  id: number
  label: string
  primaryText: string
  text: string
}

function siblingPaths(path: string) {
  const base = path.replace(/\.json$/, "")
  return { metaPath: `${base}.meta.jsonl`, vectorsPath: `${base}.vectors.bin` }
}

/**
 * Reads which ids a previous run already embedded, and repairs a torn write.
 *
 * A crash between the meta append and the vector append (or mid-append) leaves
 * the two files describing different numbers of entries; since entry `i`'s
 * vector is located purely by offset, a single-row skew silently misaligns
 * every vector after it. So both files are truncated back to the number of
 * entries that are complete in both.
 */
function loadResumeState(indexPath: string, dim: number): { ids: Set<number>; count: number } {
  const { metaPath, vectorsPath } = siblingPaths(indexPath)
  const ids = new Set<number>()
  if (!existsSync(metaPath) || !existsSync(vectorsPath)) return { ids, count: 0 }

  const metaRaw = readFileSync(metaPath, "utf-8")
  const lines = metaRaw.split("\n").filter((l) => l.trim().length > 0)
  const vectorEntries = Math.floor(statSync(vectorsPath).size / (dim * 4))
  const complete = Math.min(lines.length, vectorEntries)

  if (lines.length !== vectorEntries) {
    console.log(
      `Repairing torn checkpoint: ${lines.length} meta rows vs ${vectorEntries} vectors — truncating both to ${complete}.`
    )
    writeFileSync(metaPath, lines.slice(0, complete).map((l) => `${l}\n`).join(""), "utf-8")
    const fd = openSync(vectorsPath, "r+")
    try {
      ftruncateSync(fd, complete * dim * 4)
    } finally {
      closeSync(fd)
    }
  }

  for (let i = 0; i < complete; i++) {
    ids.add((JSON.parse(lines[i]!) as { id: number }).id)
  }
  return { ids, count: complete }
}

async function main() {
  const config = loadEmbeddingConfig()
  if (!existsSync(QUEUE_PATH)) throw new Error(`No embed queue at ${QUEUE_PATH} — run bench:ingest:full first.`)
  mkdirSync(dirname(INDEX_PATH), { recursive: true })

  // Probe the model for its real dimensionality rather than assuming 1024 —
  // the offsets of every vector in the blob depend on getting this right.
  const dim = (await embedText("dimension probe", config)).length
  console.log(`Embedding model ${config.modelId} → ${dim} dims`)

  const { metaPath, vectorsPath } = siblingPaths(INDEX_PATH)
  const resume = loadResumeState(INDEX_PATH, dim)
  if (resume.count > 0) console.log(`Resuming: ${resume.count.toLocaleString()} entries already embedded.`)

  const metaFd = openSync(metaPath, "a")
  const vectorsFd = openSync(vectorsPath, "a")
  let written = resume.count
  let failed = 0
  let skipped = 0

  const writeDescriptor = () => writeFileSync(INDEX_PATH, JSON.stringify({ count: written, dim }), "utf-8")

  /**
   * Appends one batch. Order matters: the vector goes down first, so a crash
   * can only ever leave a vector with no meta row (which loadResumeState trims)
   * rather than a meta row pointing at absent bytes.
   */
  const flush = (rows: { item: QueueItem; vector: number[] }[]) => {
    for (const { item, vector } of rows) {
      const buffer = Buffer.from(Float32Array.from(vector).buffer)
      writeSync(vectorsFd, buffer)
      writeSync(metaFd, `${JSON.stringify({ id: item.id, label: item.label, primaryText: item.primaryText })}\n`)
      written++
    }
  }

  const startedAt = Date.now()
  let processed = 0
  let sinceFlush = 0
  let seen = 0
  const inFlight = new Set<Promise<void>>()

  /**
   * One item, start to written, called from a continuously refilled pool: a
   * finished slot starts its next request immediately instead of waiting for a
   * batch to drain.
   *
   * Don't expect a speedup from this. It replaced fixed CONCURRENCY-sized
   * batches on the theory that every slot idling until the slowest call in its
   * batch returned was the reason per-slot latency looked so high — and
   * measurement said no, both run at the same rate, because the wait is
   * account-side queueing at Bedrock (see CONCURRENCY). It's kept because it's
   * the more honest structure for a latency-bound queue and because it makes
   * throughput a function of one variable rather than two, not because it's
   * faster.
   *
   * Each row writes its own vector-then-meta pair, so completion order doesn't
   * matter to alignment — the two files stay in step by construction, which is
   * what makes an out-of-order pool safe here at all.
   */
  const runOne = async (item: QueueItem) => {
    try {
      const vector = await embedWithRetry(item.text, config)
      flush([{ item, vector }])
    } catch (err) {
      failed++
      if (failed <= 20) console.warn(`  embed failed id=${item.id} (${item.label}): ${(err as Error).message}`)
    }
    processed++
    sinceFlush++
    if (sinceFlush >= FLUSH_EVERY) {
      writeDescriptor()
      sinceFlush = 0
      const perSec = processed / ((Date.now() - startedAt) / 1000)
      console.log(
        `  ${written.toLocaleString()} embedded (+${processed.toLocaleString()} this run, ${failed} failed), ` +
          `${perSec.toFixed(1)}/s`
      )
    }
  }

  // The queue is streamed, not loaded: 500k rows carrying 4 KB of text each is
  // ~2 GB of JSON that this process has no reason to hold.
  const rl = createInterface({ input: createReadStream(QUEUE_PATH), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    const item = JSON.parse(line) as QueueItem
    seen++
    if (resume.ids.has(item.id)) {
      skipped++
      continue
    }
    // Guards against the queue listing an id twice (and against a retry
    // re-appending one) — the sidecar has no upsert, only append.
    resume.ids.add(item.id)
    if (!item.text?.trim()) continue

    // Start it immediately and only block once the pool is full, so reading the
    // queue never waits on a request that has nothing to do with it.
    const task = runOne(item).finally(() => inFlight.delete(task))
    inFlight.add(task)
    if (inFlight.size >= CONCURRENCY) await Promise.race(inFlight)
  }
  await Promise.all(inFlight)

  writeDescriptor()
  closeSync(metaFd)
  closeSync(vectorsFd)

  console.log(
    `\nDone in ${((Date.now() - startedAt) / 60000).toFixed(1)} min.\n` +
      `Queue rows: ${seen.toLocaleString()} (${skipped.toLocaleString()} already embedded, ${failed} failed)\n` +
      `Index: ${written.toLocaleString()} entries × ${dim} dims at ${INDEX_PATH}\n` +
      `Point the app at it with VECTOR_INDEX_PATH=${INDEX_PATH}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
