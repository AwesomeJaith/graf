import "dotenv/config"
import { loadByogConfig, runQueryByog } from "@workspace/graph-client"

/**
 * Measures cross-document `REFERENCES` quality on a loaded graph.
 *
 * Edge *counts* can't distinguish a well-linked corpus from an over-matched one,
 * and this relationship type is the one most likely to be wrong: it comes from
 * matching free-text tokens in one document's link fields against other
 * documents' declared keys, so a single token that isn't really an identifier
 * can manufacture thousands of edges. The first full load did exactly that —
 * 7,376 edges from `123456`, the fractional half of Slack thread timestamps.
 *
 * The signal that separates the two cases is **target in-degree**. Real
 * references are spread thin: a document is cited by a handful of others. An
 * over-matched key produces a hub — one document cited by thousands, all of them
 * arbitrary, because the key resolved to whichever document declared it last.
 *
 * A whole-graph `count(*) ... GROUP BY` blows the 8s read budget at 3M
 * relationships, so this partitions the (uniformly hashed) id space into ranges
 * and aggregates each one separately, which keeps every query on the indexed
 * `id` attribute.
 *
 * Read-only by default. `--prune` additionally deletes every `REFERENCES` edge
 * pointing at a hub, which is the only way to clean a graph that was loaded
 * before `MAX_KEY_FANOUT` existed — re-running the ingest `MERGE`s edges and so
 * can only ever add them. Prune *before* re-running the references pass, so that
 * legitimate edges into those same targets get restored by it.
 *
 * Usage: `pnpm run bench:audit:references [--prune]`.
 */

const CONTENT_LABELS = ["Document", "Message", "Task", "Issue"] as const

/** Ids are `10000 + hash % 2^50`, distributed uniformly, so equal ranges hold equal counts. */
const ID_SPACE = 2 ** 50
const PARTITIONS = 64

/** In-degree above which a target is a hub rather than a genuinely popular document. */
const HUB_THRESHOLD = Number(process.env.REFERENCE_HUB_THRESHOLD ?? 200)

/** Kept well inside the 30s write budget; hubs run to thousands of edges. */
const DELETE_BATCH = 5_000

const prune = process.argv.includes("--prune")

interface Target {
  id: number
  label: string
  inDegree: number
}

async function scanLabel(label: string): Promise<Target[]> {
  const targets: Target[] = []
  const width = Math.ceil(ID_SPACE / PARTITIONS)
  for (let i = 0; i < PARTITIONS; i++) {
    const lo = i * width
    const hi = lo + width
    const rows = await runQueryByog(
      `MATCH (a)-[r]->(b:${label}) WHERE r.rel_type = "REFERENCES" AND b.id >= ${lo} AND b.id < ${hi} ` +
        `RETURN b.id AS id, count(*) AS n ORDER BY n DESC LIMIT 2000`
    )
    for (const row of rows) {
      if (typeof row.id === "number" && typeof row.n === "number") {
        targets.push({ id: row.id, label, inDegree: row.n })
      }
    }
    process.stdout.write(`  ${label}: partition ${i + 1}/${PARTITIONS}, ${targets.length.toLocaleString()} targets\r`)
  }
  return targets
}

async function primaryText(label: string, id: number): Promise<string> {
  const rows = await runQueryByog(`MATCH (n:${label} {id: ${id}}) RETURN n.primary_text AS t`)
  const value = rows[0]?.t
  return typeof value === "string" ? value : ""
}

async function main(): Promise<void> {
  const config = loadByogConfig()
  console.log(`Auditing REFERENCES in ${config.database}/${config.collection}\n`)

  const all: Target[] = []
  for (const label of CONTENT_LABELS) {
    const targets = await scanLabel(label)
    console.log(`  ${label}: ${targets.length.toLocaleString()} distinct targets                    `)
    all.push(...targets)
  }

  const edges = all.reduce((sum, t) => sum + t.inDegree, 0)
  console.log(
    `\n${edges.toLocaleString()} cross-document REFERENCES edges over ` +
      `${all.length.toLocaleString()} distinct targets (mean in-degree ${(edges / Math.max(all.length, 1)).toFixed(2)}).`
  )

  // A healthy distribution is almost entirely 1s and 2s. Anything in the tail is
  // where an over-matched key would show up.
  console.log("\n── In-degree distribution ──")
  const buckets: [string, (n: number) => boolean][] = [
    ["1", (n) => n === 1],
    ["2-5", (n) => n >= 2 && n <= 5],
    ["6-20", (n) => n >= 6 && n <= 20],
    ["21-100", (n) => n >= 21 && n <= 100],
    ["101-1000", (n) => n >= 101 && n <= 1000],
    [">1000", (n) => n > 1000],
  ]
  for (const [name, test] of buckets) {
    const matching = all.filter((t) => test(t.inDegree))
    const share = ((matching.reduce((s, t) => s + t.inDegree, 0) / Math.max(edges, 1)) * 100).toFixed(1)
    console.log(`  in-degree ${name.padEnd(9)} ${matching.length.toLocaleString().padStart(8)} targets  ${share.padStart(5)}% of edges`)
  }

  const hubs = all.filter((t) => t.inDegree > HUB_THRESHOLD).sort((a, b) => b.inDegree - a.inDegree)
  console.log(`\n── Hubs (in-degree > ${HUB_THRESHOLD}) ──`)
  if (hubs.length === 0) {
    console.log("  none — no single document is referenced by an implausible number of others.")
  } else {
    const hubEdges = hubs.reduce((s, t) => s + t.inDegree, 0)
    for (const hub of hubs.slice(0, 15)) {
      const text = await primaryText(hub.label, hub.id)
      console.log(`  ${String(hub.inDegree).padStart(6)} inbound  ${hub.label} ${hub.id}  ${JSON.stringify(text.slice(0, 60))}`)
    }
    console.log(
      `\n  ${hubs.length} hubs absorb ${hubEdges.toLocaleString()} edges ` +
        `(${((hubEdges / Math.max(edges, 1)) * 100).toFixed(1)}% of all cross-document REFERENCES).`
    )

    if (!prune) {
      console.log("  Re-run with --prune to delete them.")
      return
    }

    console.log("\n── Pruning ──")
    let deleted = 0
    for (const hub of hubs) {
      // Batched because a single DELETE over thousands of edges exceeds the write
      // budget; self-terminating because each batch shrinks the matching set.
      for (;;) {
        const rows = await runQueryByog(
          `MATCH (a)-[r]->(b:${hub.label} {id: ${hub.id}}) WHERE r.rel_type = "REFERENCES" ` +
            `WITH r LIMIT ${DELETE_BATCH} DELETE r RETURN count(*) AS n`
        )
        const n = typeof rows[0]?.n === "number" ? rows[0].n : 0
        if (n === 0) break
        deleted += n
        process.stdout.write(`  ${deleted.toLocaleString()} edges deleted\r`)
      }
    }
    console.log(`  ${deleted.toLocaleString()} hub edges deleted.                    `)
    console.log("  Now re-run the ingest so the references pass restores legitimate edges into these targets.")
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
