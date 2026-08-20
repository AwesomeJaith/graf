import "dotenv/config"
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { createReadStream } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { embedText, loadVectorIndex } from "@workspace/vector-index"

/**
 * Checks a vector-index sidecar is actually loadable and correctly aligned.
 *
 * embed-full.ts writes the sidecar by appending to the meta/vector files rather
 * than going through VectorIndex.save(), because re-serializing a ~2 GB blob on
 * every checkpoint costs more wall-clock than the Bedrock calls themselves. The
 * risk that buys is silent misalignment: every vector is located purely by
 * offset, so one skewed row shifts every vector after it and the index still
 * "loads" fine while returning nonsense. A round-trip check is cheap insurance.
 *
 * Alignment is verified by re-embedding a sampled entry's own text and
 * confirming it scores ~1.0 against itself — a shifted vector would score near
 * zero.
 *
 * The text has to be *exactly* what was embedded, which means reading it back
 * out of the embed queue rather than using the meta sidecar's `primaryText`.
 * Content nodes are embedded as `[primaryText, body]`, so re-embedding the title
 * alone scores a healthy entry anywhere from 0.4 to 0.8 and frequently ranks
 * some other document first — indistinguishable from the corruption this check
 * exists to catch. Only bodyless labels (Person, Organization) scored ~1.0, which
 * is what made the blind spot look like a working check.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = process.argv[2] ?? process.env.VECTOR_INDEX_PATH ?? join(__dirname, "..", "data", "vector-index.full.json")
const WORK_DIR = process.env.BENCH_WORK_DIR ?? join(__dirname, "..", "data", "full-ingest")
const SAMPLES = 5

async function main() {
  const descriptor = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as { count: number; dim: number }
  const index = loadVectorIndex(INDEX_PATH)
  console.log(`${INDEX_PATH}\n  descriptor: ${descriptor.count.toLocaleString()} × ${descriptor.dim}`)
  console.log(`  loaded:     ${index.size().toLocaleString()} entries`)
  if (index.size() !== descriptor.count) {
    console.log(`  MISMATCH: descriptor and loaded count differ`)
  }

  const byLabel = new Map<string, number>()
  const metaPath = INDEX_PATH.replace(/\.json$/, ".meta.jsonl")
  const rl = createInterface({ input: createReadStream(metaPath), crlfDelay: Infinity })
  const samples: { id: number; label: string; primaryText: string }[] = []
  let line = 0
  const stride = Math.max(1, Math.floor(descriptor.count / SAMPLES))
  for await (const raw of rl) {
    if (!raw.trim()) continue
    const meta = JSON.parse(raw) as { id: number; label: string; primaryText: string }
    byLabel.set(meta.label, (byLabel.get(meta.label) ?? 0) + 1)
    if (line % stride === 0 && samples.length < SAMPLES) samples.push(meta)
    line++
  }
  console.log("  by label:")
  for (const [label, count] of Array.from(byLabel.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${label.padEnd(14)} ${count.toLocaleString()}`)
  }

  // The queue is the source of truth for what *should* be embedded; a large
  // shortfall means failures were retried out rather than throttled through.
  // The same pass grabs the exact queued text for the sampled ids, so alignment
  // can re-embed what was really embedded.
  const sampledIds = new Set(samples.map((s) => s.id))
  const queuedText = new Map<number, string>()
  try {
    const queueIds = new Set<number>()
    const qrl = createInterface({ input: createReadStream(join(WORK_DIR, "embed-queue.jsonl")), crlfDelay: Infinity })
    for await (const raw of qrl) {
      if (!raw.trim()) continue
      const item = JSON.parse(raw) as { id: number; text?: string }
      queueIds.add(item.id)
      if (sampledIds.has(item.id) && typeof item.text === "string") queuedText.set(item.id, item.text)
    }
    let missing = 0
    for (const id of queueIds) if (!index.hasId(id)) missing++
    console.log(`  queue coverage: ${(queueIds.size - missing).toLocaleString()}/${queueIds.size.toLocaleString()} embedded (${missing.toLocaleString()} missing)`)
  } catch {
    console.log("  queue coverage: embed queue not readable, skipped")
  }

  console.log("\n── Alignment (exact queued text should self-score ~1.0) ──")
  let misaligned = 0
  let approximate = 0
  for (const sample of samples) {
    const exact = queuedText.get(sample.id)
    const text = exact ?? (sample.primaryText || String(sample.id))
    const vector = await embedText(text)
    const self = index.searchAmong(vector, [sample.id], 1)[0]
    const score = self?.score ?? 0
    // 0.99 rather than 1.0: the stored vector is float32 and the query vector
    // comes back from Bedrock fresh, so exact equality isn't guaranteed.
    const verdict = exact ? (score >= 0.99 ? "ok" : "MISALIGNED") : "approx (text not in queue)"
    if (exact && score < 0.99) misaligned++
    if (!exact) approximate++
    console.log(
      `  id=${sample.id} ${sample.label.padEnd(12)} self=${score.toFixed(3)} ${verdict.padEnd(26)} "${sample.primaryText.slice(0, 40)}"`
    )
  }
  if (misaligned > 0) {
    console.log(`\n  FAIL: ${misaligned}/${samples.length} sampled vectors don't match their own text — the sidecar is skewed.`)
    process.exitCode = 1
  } else if (approximate === samples.length) {
    console.log(`\n  INCONCLUSIVE: no sampled ids found in the embed queue, so nothing was checked against exact text.`)
  } else {
    console.log(`\n  ${samples.length - approximate}/${samples.length} sampled vectors verified against their exact queued text.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
