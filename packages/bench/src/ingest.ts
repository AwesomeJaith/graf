import "dotenv/config"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { closeDriver, runWrites } from "@workspace/graph-client"
import {
  upsertNodesBatch,
  upsertRelationshipsBatch,
  type UpsertNodeRow,
  type UpsertRelationshipRow,
} from "@workspace/graph-client"
import { VectorIndex, embedText } from "@workspace/vector-index"
import { loadRawDocs, loadQuestions } from "./loader"
import { normalizeDoc, type ContentLabel, type NormalizedDoc } from "./adapt"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR =
  process.env.BENCH_DATA_DIR ??
  join(__dirname, "..", "data", "enterprise-rag-bench-sample")
const QUESTIONS_FILE = process.env.BENCH_QUESTIONS_FILE ?? "questions.sample.jsonl"
const VECTOR_INDEX_PATH =
  process.env.VECTOR_INDEX_PATH ??
  join(__dirname, "..", "data", "vector-index.sample.json")
// Full-corpus runs write hundreds of thousands of rows — one UNWIND per
// label/rel-type with every row inline would build a single Bolt message far
// past any reasonable size and either time out or get rejected outright. Kept
// small because node properties now carry full multi-field document text
// (post content-extraction fix), not just short titles — 1000 rows of full
// document bodies is a much bigger payload than 1000 rows used to be.
const WRITE_BATCH_SIZE = 200

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs write batches in small groups (short-lived sessions, visible progress
 * for a many-hour run) with retry-with-backoff around each group — a bolt
 * connection through the local docker-proxied HydraDB dev instance has been
 * seen to drop mid-stream under sustained write load (EPIPE), and this is a
 * multi-hour unattended job that shouldn't abort entirely over one transient
 * disconnect.
 */
async function runWritesWithProgress(
  specs: { query: string; params?: Record<string, unknown> }[],
  label: string,
  groupSize = 5
): Promise<void> {
  const groups = chunk(specs, groupSize)
  let done = 0
  for (const group of groups) {
    let attempt = 0
    for (;;) {
      try {
        await runWrites(group)
        break
      } catch (err) {
        attempt++
        if (attempt > 5) throw err
        const delayMs = 2000 * attempt
        console.warn(`  ${label}: write group failed (attempt ${attempt}/5), retrying in ${delayMs}ms: ${(err as Error).message}`)
        await sleep(delayMs)
      }
    }
    done += group.length
    console.log(`  ${label}: ${done}/${specs.length} batches written`)
  }
}

// Ids below 10000 are reserved for the hand-authored seed-demo.ts graph so
// both can coexist in the same HydraDB namespace without id collisions.
let nextId = 10000
function id(): number {
  return nextId++
}

const REDWOOD_ORG_ID = id() // "Redwood Inference" — the fictional company every ingested Person works at.

interface RelRow {
  relType: string
  sourceLabel: string
  destinationLabel: string
  row: UpsertRelationshipRow
}

async function main() {
  const rawDocs = loadRawDocs(DATA_DIR)
  const questions = loadQuestions(DATA_DIR, QUESTIONS_FILE)
  console.log(
    `Loaded ${rawDocs.length} raw docs, ${questions.length} questions from ${DATA_DIR}`
  )

  const normalized: NormalizedDoc[] = []
  for (const raw of rawDocs) {
    const doc = normalizeDoc(raw)
    if (doc) normalized.push(doc)
    else console.warn(`No adapter for source type: ${raw.sourceType}`)
  }

  const personId = new Map<string, number>()
  const orgId = new Map<string, number>()
  const projectId = new Map<string, number>()
  const channelId = new Map<string, number>()
  const docId = new Map<string, number>()
  const docByDsid = new Map<string, NormalizedDoc>()

  for (const doc of normalized) {
    docId.set(doc.dsid, id())
    docByDsid.set(doc.dsid, doc)
    for (const p of doc.people)
      if (!personId.has(p.name)) personId.set(p.name, id())
    if (doc.projectKey && !projectId.has(doc.projectKey))
      projectId.set(doc.projectKey, id())
    if (doc.channelKey && !channelId.has(doc.channelKey))
      channelId.set(doc.channelKey, id())
    if (doc.companyName && !orgId.has(doc.companyName))
      orgId.set(doc.companyName, id())
  }

  const nodesByLabel = new Map<string, UpsertNodeRow[]>()
  function pushNode(label: string, row: UpsertNodeRow) {
    const list = nodesByLabel.get(label) ?? []
    list.push(row)
    nodesByLabel.set(label, list)
  }

  pushNode("Organization", {
    id: REDWOOD_ORG_ID,
    label: "Organization",
    primary_text: "Redwood Inference",
    name: "Redwood Inference",
    kind: "internal",
  })
  for (const [name, pid] of personId) {
    pushNode("Person", {
      id: pid,
      label: "Person",
      primary_text: name,
      name,
      source: "bench",
    })
  }
  for (const [company, oid] of orgId) {
    pushNode("Organization", {
      id: oid,
      label: "Organization",
      primary_text: company,
      name: company,
      kind: "customer",
    })
  }
  for (const [key, pid] of projectId) {
    pushNode("Project", {
      id: pid,
      label: "Project",
      primary_text: key,
      name: key,
      summary: "",
      status: "",
    })
  }
  for (const [key, cid] of channelId) {
    pushNode("Channel", {
      id: cid,
      label: "Channel",
      primary_text: key,
      name: key,
      source: "slack",
    })
  }
  for (const doc of normalized) {
    pushNode(doc.label, {
      id: docId.get(doc.dsid)!,
      label: doc.label,
      primary_text: doc.primaryText,
      dsid: doc.dsid,
      ...doc.properties,
    })
  }

  const relRows: RelRow[] = []
  for (const pid of personId.values()) {
    relRows.push({
      relType: "MEMBER_OF",
      sourceLabel: "Person",
      destinationLabel: "Organization",
      row: {
        id: id(),
        rel_type: "MEMBER_OF",
        sourceId: pid,
        destinationId: REDWOOD_ORG_ID,
      },
    })
  }
  for (const doc of normalized) {
    const nodeId = docId.get(doc.dsid)!
    for (const p of doc.people) {
      relRows.push({
        relType: p.relation,
        sourceLabel: p.relation === "AUTHORED" ? "Person" : doc.label,
        destinationLabel: p.relation === "AUTHORED" ? doc.label : "Person",
        row: {
          id: id(),
          rel_type: p.relation,
          sourceId: p.relation === "AUTHORED" ? personId.get(p.name)! : nodeId,
          destinationId:
            p.relation === "AUTHORED" ? nodeId : personId.get(p.name)!,
        },
      })
    }
    if (doc.projectKey) {
      relRows.push({
        relType: "PART_OF",
        sourceLabel: doc.label,
        destinationLabel: "Project",
        row: {
          id: id(),
          rel_type: "PART_OF",
          sourceId: nodeId,
          destinationId: projectId.get(doc.projectKey)!,
        },
      })
    }
    if (doc.channelKey) {
      relRows.push({
        relType: "DISCUSSED_IN",
        sourceLabel: doc.label,
        destinationLabel: "Channel",
        row: {
          id: id(),
          rel_type: "DISCUSSED_IN",
          sourceId: nodeId,
          destinationId: channelId.get(doc.channelKey)!,
        },
      })
    }
    if (doc.companyName && orgId.has(doc.companyName)) {
      relRows.push({
        relType: "REFERENCES",
        sourceLabel: doc.label,
        destinationLabel: "Organization",
        row: {
          id: id(),
          rel_type: "REFERENCES",
          sourceId: nodeId,
          destinationId: orgId.get(doc.companyName)!,
        },
      })
    }
  }

  // Cross-link resolution: connect docs that reference each other by ticket
  // key / thread id / pr number rather than by dataset uuid. The original
  // approach substring-matched every doc's linkTexts against every other
  // doc's knownKeys directly — O(n^2), fine at ~135 docs, impossible at
  // full-corpus scale (hundreds of billions of comparisons). Instead, index
  // every knownKey once, then tokenize each doc's linkTexts and look each
  // token up — O(total link-text tokens), linear in corpus size. This trades
  // true substring containment for exact-token matching, which loses nothing
  // for identifiers like ticket keys/PR numbers/thread ids (they're already
  // clean alphanumeric tokens) while avoiding spurious partial-substring hits.
  const keyIndex = new Map<string, NormalizedDoc[]>()
  for (const doc of normalized) {
    for (const key of doc.knownKeys) {
      if (key.length < 4) continue
      const k = key.toLowerCase()
      const list = keyIndex.get(k) ?? []
      list.push(doc)
      keyIndex.set(k, list)
    }
  }
  let referenceCount = 0
  for (const a of normalized) {
    if (a.linkTexts.length === 0) continue
    const seenTargets = new Set<NormalizedDoc>()
    for (const text of a.linkTexts) {
      const tokens = text.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? []
      for (const token of tokens) {
        const hits = keyIndex.get(token)
        if (!hits) continue
        for (const b of hits) {
          if (b === a || seenTargets.has(b)) continue
          seenTargets.add(b)
          relRows.push({
            relType: "REFERENCES",
            sourceLabel: a.label,
            destinationLabel: b.label,
            row: {
              id: id(),
              rel_type: "REFERENCES",
              sourceId: docId.get(a.dsid)!,
              destinationId: docId.get(b.dsid)!,
            },
          })
          referenceCount++
        }
      }
    }
  }
  console.log(
    `Resolved ${referenceCount} cross-document REFERENCES edges from link-text matching.`
  )

  // Ground-truth conflicts: conflicting_info questions are generated from a
  // near-duplicate document pair by construction (see methodology.md), so
  // the benchmark itself tells us which two ingested docs actually conflict.
  let contradictionCount = 0
  for (const q of questions) {
    if (
      q.question_type !== "conflicting_info" ||
      q.expected_doc_ids.length !== 2
    )
      continue
    const [aId, bId] = q.expected_doc_ids
    const a = docByDsid.get(aId!)
    const b = docByDsid.get(bId!)
    if (!a || !b) continue
    relRows.push({
      relType: "CONTRADICTS",
      sourceLabel: a.label,
      destinationLabel: b.label,
      row: {
        id: id(),
        rel_type: "CONTRADICTS",
        sourceId: docId.get(a.dsid)!,
        destinationId: docId.get(b.dsid)!,
        source_question: q.question_id,
      },
    })
    contradictionCount++
  }
  console.log(
    `Added ${contradictionCount} CONTRADICTS edges from conflicting_info questions.`
  )

  const totalNodes = [...nodesByLabel.values()].reduce((n, r) => n + r.length, 0)
  const nodeWrites = [...nodesByLabel.entries()].flatMap(([label, rows]) =>
    chunk(rows, WRITE_BATCH_SIZE).map((batch) => upsertNodesBatch(label, batch))
  )
  console.log(`Writing ${totalNodes} nodes in ${nodeWrites.length} batches of up to ${WRITE_BATCH_SIZE}...`)
  await runWritesWithProgress(nodeWrites, "nodes")
  console.log(`Wrote ${totalNodes} nodes.`)

  const relGroups = new Map<string, RelRow[]>()
  for (const r of relRows) {
    const key = `${r.relType}|${r.sourceLabel}|${r.destinationLabel}`
    const list = relGroups.get(key) ?? []
    list.push(r)
    relGroups.set(key, list)
  }
  const relWrites = [...relGroups.entries()].flatMap(([key, rows]) => {
    const [relType, sourceLabel, destinationLabel] = key.split("|") as [
      string,
      string,
      string,
    ]
    return chunk(rows, WRITE_BATCH_SIZE).map((batch) =>
      upsertRelationshipsBatch(
        relType,
        sourceLabel,
        destinationLabel,
        batch.map((r) => r.row)
      )
    )
  })
  console.log(`Writing ${relRows.length} relationships in ${relWrites.length} batches of up to ${WRITE_BATCH_SIZE}...`)
  await runWritesWithProgress(relWrites, "relationships")
  console.log(
    `Wrote ${relRows.length} relationships across ${relGroups.size} label-pair batches.`
  )

  await closeDriver()

  console.log(
    "Embedding entities for the vector-index sidecar (this calls Bedrock once per entity)..."
  )
  const index = new VectorIndex()
  // A full-corpus run embeds 500k+ entities over many hours — load whatever
  // a prior (possibly interrupted) run already saved and skip those ids, so
  // re-running this script after a crash/restart resumes instead of redoing
  // everything from scratch.
  index.load(VECTOR_INDEX_PATH)
  const alreadyEmbedded = index.size()
  if (alreadyEmbedded > 0) console.log(`Resuming: ${alreadyEmbedded} entities already embedded from a prior run.`)

  const embedTargets: {
    id: number
    label: string
    primaryText: string
    text: string
  }[] = []
  for (const [label, rows] of nodesByLabel) {
    for (const row of rows) {
      const text = [
        row.primary_text,
        row.content,
        row.description,
        row.body,
        row.text,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000)
      const fallback = text || String(row.primary_text) || label
      if (!fallback.trim()) continue // nothing to embed (empty primary_text and no content)
      embedTargets.push({
        id: row.id,
        label,
        primaryText: String(row.primary_text),
        text: fallback,
      })
    }
  }
  const remaining = embedTargets.filter((t) => !index.hasId(t.id))
  console.log(`${embedTargets.length} entities to embed, ${remaining.length} remaining after resume-skip.`)

  let embedded = 0
  let failed = 0
  const CONCURRENCY = 8
  const SAVE_EVERY = 2000
  let sinceLastSave = 0
  try {
    for (let i = 0; i < remaining.length; i += CONCURRENCY) {
      const batch = remaining.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (t) => {
          try {
            return { t, vector: await embedText(t.text) }
          } catch (err) {
            failed++
            console.warn(`  embed failed for id=${t.id} (${t.label}): ${(err as Error).message}`)
            return null
          }
        })
      )
      const ok = results.filter((r): r is { t: (typeof batch)[number]; vector: number[] } => r !== null)
      index.upsert(ok.map(({ t, vector }) => ({ id: t.id, label: t.label, primaryText: t.primaryText, vector })))
      embedded += batch.length
      sinceLastSave += batch.length
      console.log(`  embedded ${embedded}/${remaining.length} (${failed} failed so far)`)
      if (sinceLastSave >= SAVE_EVERY) {
        index.save(VECTOR_INDEX_PATH)
        sinceLastSave = 0
        console.log(`  checkpoint saved (${index.size()} total embeddings)`)
      }
    }
  } finally {
    index.save(VECTOR_INDEX_PATH)
    console.log(`Saved ${index.size()} embeddings to ${VECTOR_INDEX_PATH} (${failed} failed and skipped).`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
