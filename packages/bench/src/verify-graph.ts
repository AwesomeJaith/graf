import "dotenv/config"
import { loadByogConfig, runQueryByog } from "@workspace/graph-client"
import { loadGraphSchema } from "@workspace/graph-schema"

/**
 * Post-ingest validation for a loaded HydraDB graph.
 *
 * Row counts alone can't tell a good load from a bad one — the previous
 * full-corpus attempt reported hundreds of thousands of written nodes while
 * being unusable (no relationships, no content nodes, ids reassigned between
 * shards). So this checks the properties the app actually depends on:
 *
 *   - per-label and per-relationship-type counts, to catch a phase that
 *     silently wrote nothing;
 *   - that content nodes carry real `primary_text`/body text, not just ids;
 *   - that a one-hop expansion from a sampled node returns oriented edges,
 *     which is the exact query shape retrieval traversal uses;
 *   - a sample of REFERENCES edges printed with both endpoints' text, so
 *     cross-document links can be eyeballed for the false-positive blowup
 *     that inflated the last run's edge count.
 *
 * Point it at a collection with HYDRADB_BYOG_COLLECTION.
 */

const CONTENT_LABELS = ["Document", "Message", "Task", "Issue"]

async function tryQuery(query: string, params: Record<string, unknown> = {}) {
  try {
    return await runQueryByog(query, params)
  } catch (err) {
    return { error: (err as Error).message }
  }
}

function firstNumber(rows: unknown, key: string): number | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined
  const value = (rows[0] as Record<string, unknown>)[key]
  return typeof value === "number" ? value : undefined
}

async function main() {
  const config = loadByogConfig()
  const schema = loadGraphSchema()
  console.log(`Verifying ${config.baseUrl} database=${config.database} collection=${config.collection}\n`)

  console.log("── Node counts ──")
  let totalNodes = 0
  const populated: string[] = []
  for (const entry of schema.nodeLabels) {
    const rows = await tryQuery(`MATCH (n:${entry.label}) RETURN count(*) AS c`)
    const count = firstNumber(rows, "c")
    if (count === undefined) continue
    totalNodes += count
    if (count > 0) populated.push(entry.label)
    console.log(`  ${entry.label.padEnd(14)} ${count.toLocaleString()}`)
  }
  console.log(`  ${"TOTAL".padEnd(14)} ${totalNodes.toLocaleString()}`)

  console.log("\n── Relationship counts ──")
  let totalRels = 0
  for (const rel of schema.relationships) {
    const rows = await tryQuery(`MATCH ()-[r:${rel.type}]->() RETURN count(*) AS c`)
    const count = firstNumber(rows, "c")
    if (count === undefined || count === 0) continue
    totalRels += count
    console.log(`  ${rel.type.padEnd(14)} ${count.toLocaleString()}`)
  }
  console.log(`  ${"TOTAL".padEnd(14)} ${totalRels.toLocaleString()}`)

  // A load that wrote entity nodes but dropped document bodies looks healthy by
  // count and is useless for answering questions — check the text is there.
  console.log("\n── Content nodes carry body text ──")
  for (const label of CONTENT_LABELS.filter((l) => populated.includes(l))) {
    const rows = await tryQuery(
      `MATCH (n:${label}) RETURN n.id AS id, n.primary_text AS primaryText, n.dsid AS dsid, n.content AS content, n.description AS description, n.body AS body, n.text AS text LIMIT 3`
    )
    if (!Array.isArray(rows)) {
      console.log(`  ${label}: ${JSON.stringify(rows)}`)
      continue
    }
    for (const row of rows as Record<string, unknown>[]) {
      const body = [row.content, row.description, row.body, row.text].filter((v) => typeof v === "string" && v).join("")
      console.log(
        `  ${label} id=${row.id} dsid=${String(row.dsid).slice(0, 20)} ` +
          `primary_text=${JSON.stringify(String(row.primaryText ?? "").slice(0, 60))} bodyChars=${body.length}`
      )
    }
  }

  console.log("\n── One-hop expansion (the traversal query shape) ──")
  for (const label of ["Person", "Project"].filter((l) => populated.includes(l))) {
    const seeds = await tryQuery(`MATCH (n:${label}) RETURN n.id AS id, n.primary_text AS t LIMIT 1`)
    const seed = Array.isArray(seeds) ? (seeds[0] as { id: number; t: string } | undefined) : undefined
    if (!seed) continue
    const rows = await tryQuery(
      `UNWIND $ids AS row MATCH (a:${label} {id: row.id})-[r]-(b) WHERE r.rel_type IN $relTypes ` +
        `RETURN startNode(r).id AS sourceId, endNode(r).id AS destinationId, r.rel_type AS relType, ` +
        `b.id AS nodeId, b.label AS nodeLabel, b.primary_text AS nodePrimaryText LIMIT 5`,
      { ids: [{ id: seed.id }], relTypes: schema.relationships.map((r) => r.type) }
    )
    console.log(`  from ${label} "${seed.t}" (id=${seed.id}):`)
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`    NO EDGES — ${JSON.stringify(rows)}`)
      continue
    }
    for (const row of rows as Record<string, unknown>[]) {
      const direction = row.sourceId === seed.id ? "->" : "<-"
      console.log(`    ${direction} ${row.relType} ${row.nodeLabel} "${String(row.nodePrimaryText ?? "").slice(0, 50)}"`)
    }
  }

  // The handoff flagged 714,994 REFERENCES edges from 512k documents as
  // implausible. Print real pairs so the link-resolution rule can be judged on
  // whether these are genuine cross-document references.
  console.log("\n── REFERENCES sample (check for false positives) ──")
  const refs = await tryQuery(
    `MATCH (a)-[r:REFERENCES]->(b) RETURN a.label AS fromLabel, a.primary_text AS fromText, ` +
      `b.label AS toLabel, b.primary_text AS toText LIMIT 15`
  )
  if (!Array.isArray(refs) || refs.length === 0) {
    console.log(`  none found — ${JSON.stringify(refs)}`)
  } else {
    for (const row of refs as Record<string, unknown>[]) {
      console.log(
        `  ${row.fromLabel} "${String(row.fromText ?? "").slice(0, 45)}" → ${row.toLabel} "${String(row.toText ?? "").slice(0, 45)}"`
      )
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
