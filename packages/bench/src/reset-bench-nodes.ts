import "dotenv/config"
import { closeDriver, runGraphQuery, runWrites } from "@workspace/graph-client"

/**
 * Clears bench-ingested nodes so a sample ingest starts from a known state.
 *
 * Dry-run unless `--confirm` is passed, which is not caution for its own sake.
 * The predicate is `id >= 10000`, written when ids below 10000 were the
 * hand-authored seed-demo graph and everything above was a disposable sample
 * ingest. `ingest-full.ts` then folded its hashed ids into a 2^50 range
 * *offset by 10000* — so on an instance holding the full corpus this predicate
 * matches all 772k nodes and their ~3.1M relationships, and the seed range is
 * empty. The name and the old one-line output both still said "bench-ingested",
 * which is exactly the kind of thing you find out after running it.
 *
 * So it counts first and prints what it found, per label. A sample reset reads
 * as a few thousand rows; a full corpus reads as hundreds of thousands, and
 * that difference is visible before anything is deleted rather than after.
 */

const LABELS = ["Person", "Organization", "Project", "Channel", "Document", "Message", "Task", "Issue"]

/** Above this, the match is a corpus rather than a sample ingest. */
const SAMPLE_SCALE_LIMIT = 20000

async function main() {
  const confirm = process.argv.includes("--confirm")
  const force = process.argv.includes("--force")

  const counts = await Promise.all(
    LABELS.map(async (label) => {
      const rows = await runGraphQuery(`MATCH (n:${label}) WHERE n.id >= 10000 RETURN count(n) AS c`, {})
      return { label, count: Number(rows[0]?.c ?? 0) }
    })
  )
  const total = counts.reduce((sum, c) => sum + c.count, 0)

  for (const { label, count } of counts) {
    if (count > 0) console.log(`  ${label.padEnd(14)} ${count.toLocaleString()}`)
  }
  console.log(`Matched ${total.toLocaleString()} nodes with id >= 10000 (DETACH DELETE also drops every relationship on them).`)

  if (total === 0) {
    console.log("Nothing to clear.")
    await closeDriver()
    return
  }

  if (!confirm) {
    console.log("\nDry run — nothing deleted. Re-run with --confirm to delete the nodes listed above.")
    await closeDriver()
    return
  }

  // Deliberately a second, separate flag: --confirm says "yes, delete the
  // sample ingest", which is not the same statement as "yes, delete a corpus
  // that took hours to build". Anyone who means the second can say so.
  if (total > SAMPLE_SCALE_LIMIT && !force) {
    console.error(
      `\nRefusing: ${total.toLocaleString()} nodes is far past the ${SAMPLE_SCALE_LIMIT.toLocaleString()} a sample ingest produces, ` +
        `so this instance most likely holds a full-corpus ingest. Re-ingesting one is a multi-hour job. ` +
        `Pass --force as well if you really do mean to delete all of it.`
    )
    await closeDriver()
    process.exit(1)
  }

  await runWrites(LABELS.map((label) => ({ query: `MATCH (n:${label}) WHERE n.id >= 10000 DETACH DELETE n` })))
  console.log(`Deleted ${total.toLocaleString()} nodes and their relationships.`)
  await closeDriver()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
