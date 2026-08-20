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
 * confirming it scores ~1.0 against itself and ranks first — a shifted vector
 * would score near zero.
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
  try {
    const queueIds = new Set<number>()
    const qrl = createInterface({ input: createReadStream(join(WORK_DIR, "embed-queue.jsonl")), crlfDelay: Infinity })
    for await (const raw of qrl) {
      if (raw.trim()) queueIds.add((JSON.parse(raw) as { id: number }).id)
    }
    let missing = 0
    for (const id of queueIds) if (!index.hasId(id)) missing++
    console.log(`  queue coverage: ${(queueIds.size - missing).toLocaleString()}/${queueIds.size.toLocaleString()} embedded (${missing.toLocaleString()} missing)`)
  } catch {
    console.log("  queue coverage: embed queue not readable, skipped")
  }

  console.log("\n── Alignment (self-similarity should be ~1.0 and rank first) ──")
  for (const sample of samples) {
    const text = sample.primaryText || String(sample.id)
    const vector = await embedText(text)
    const self = index.searchAmong(vector, [sample.id], 1)[0]
    const top = index.search(vector, { topK: 1 })[0]
    console.log(
      `  id=${sample.id} ${sample.label.padEnd(12)} self=${self?.score.toFixed(3) ?? "n/a"} ` +
        `top=${top?.score.toFixed(3)} (${top?.id === sample.id ? "same entry" : `id=${top?.id} "${top?.primaryText.slice(0, 40)}"`}) ` +
        `"${text.slice(0, 45)}"`
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
