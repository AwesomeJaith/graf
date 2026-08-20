import "dotenv/config"
import { runQueryByog } from "@workspace/graph-client"

/**
 * Reclaims HydraDB Cloud memory by removing document body text from an
 * already-loaded graph.
 *
 * HydraDB Cloud is memory-resident with a hard `maxmemory` cap. The first
 * full-corpus attempt stored each document's body as a node property and
 * exhausted the instance at 54% of the corpus (~420k nodes / 1.36M
 * relationships), after which every write returned "OOM command not allowed".
 * Bodies now live in a local content sidecar instead (see ContentStore), but
 * the nodes written before that change still carry them — and they are exactly
 * what is holding the instance at its ceiling.
 *
 * This strips them in place so the ingest can resume from its checkpoint
 * rather than reloading a quarter-million documents from scratch. Nothing is
 * lost: the text is re-derived from the on-disk corpus into the sidecar on the
 * next ingest pass, which re-normalizes every shard regardless of where it
 * resumes writing.
 *
 * Each batch filters on the property still being present, so the working set
 * shrinks with every round trip: the loop is self-terminating, idempotent, and
 * safe to re-run or interrupt at any point.
 *
 * Usage: `pnpm run bench:strip-bodies` (add `--dry-run` to only report).
 */

/**
 * The body property each content label actually uses, derived from the upstream
 * corpus's `content_field_names`. Every label is checked against every property
 * because a source type can decide either way; a label that never used one just
 * reports zero.
 */
const CONTENT_LABELS = ["Document", "Message", "Task", "Issue"] as const
const BODY_PROPERTIES = ["content", "text", "description", "body"] as const

/**
 * 20k rows per REMOVE measured at ~0.8s against the cloud, comfortably inside
 * the 30s write budget, so the whole strip is a couple of dozen round trips.
 */
const BATCH = 20_000

const dryRun = process.argv.includes("--dry-run")

async function count(label: string, property: string): Promise<number> {
  const rows = await runQueryByog(
    `MATCH (n:${label}) WHERE n.${property} IS NOT NULL RETURN count(*) AS c`
  )
  return typeof rows[0]?.c === "number" ? rows[0].c : 0
}

async function strip(label: string, property: string): Promise<number> {
  let total = 0
  for (;;) {
    const rows = await runQueryByog(
      `MATCH (n:${label}) WHERE n.${property} IS NOT NULL WITH n LIMIT ${BATCH} REMOVE n.${property} RETURN count(*) AS removed`
    )
    const removed = typeof rows[0]?.removed === "number" ? rows[0].removed : 0
    if (removed === 0) return total
    total += removed
    process.stdout.write(`  ${label}.${property}: ${total.toLocaleString()} removed\r`)
  }
}

async function main(): Promise<void> {
  console.log(`${dryRun ? "Surveying" : "Stripping"} body text from HydraDB Cloud\n`)

  let grandTotal = 0
  for (const label of CONTENT_LABELS) {
    for (const property of BODY_PROPERTIES) {
      const present = await count(label, property)
      if (present === 0) continue

      if (dryRun) {
        console.log(`  ${label}.${property}: ${present.toLocaleString()} nodes carry body text`)
        grandTotal += present
        continue
      }

      const removed = await strip(label, property)
      console.log(`  ${label}.${property}: ${removed.toLocaleString()} removed          `)
      grandTotal += removed
    }
  }

  console.log(
    `\n${grandTotal.toLocaleString()} body properties ${dryRun ? "present" : "removed"}.` +
      (dryRun ? "" : " Cloud memory reclaimed; the ingest can resume from its checkpoint.")
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
