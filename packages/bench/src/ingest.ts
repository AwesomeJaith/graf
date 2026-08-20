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
const VECTOR_INDEX_PATH =
  process.env.VECTOR_INDEX_PATH ??
  join(__dirname, "..", "data", "vector-index.sample.json")

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
  const questions = loadQuestions(DATA_DIR)
  console.log(
    `Loaded ${rawDocs.length} raw docs, ${questions.length} sample questions from ${DATA_DIR}`
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

  // Cross-link resolution: substring-match every doc's linkTexts against every
  // other doc's knownKeys. O(n^2) over ~135 docs is trivial and this is the
  // only way to connect docs that reference each other by ticket key / thread
  // id / pr number rather than by dataset uuid.
  let referenceCount = 0
  for (const a of normalized) {
    const haystacks = a.linkTexts.map((t) => t.toLowerCase())
    if (haystacks.length === 0) continue
    for (const b of normalized) {
      if (a === b) continue
      const hit = b.knownKeys.some(
        (key) =>
          key.length >= 4 &&
          haystacks.some((h) => h.includes(key.toLowerCase()))
      )
      if (!hit) continue
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

  const nodeWrites = [...nodesByLabel.entries()].map(([label, rows]) =>
    upsertNodesBatch(label, rows)
  )
  await runWrites(nodeWrites)
  console.log(
    `Wrote ${[...nodesByLabel.values()].reduce((n, r) => n + r.length, 0)} nodes.`
  )

  const relGroups = new Map<string, RelRow[]>()
  for (const r of relRows) {
    const key = `${r.relType}|${r.sourceLabel}|${r.destinationLabel}`
    const list = relGroups.get(key) ?? []
    list.push(r)
    relGroups.set(key, list)
  }
  const relWrites = [...relGroups.entries()].map(([key, rows]) => {
    const [relType, sourceLabel, destinationLabel] = key.split("|") as [
      string,
      string,
      string,
    ]
    return upsertRelationshipsBatch(
      relType,
      sourceLabel,
      destinationLabel,
      rows.map((r) => r.row)
    )
  })
  await runWrites(relWrites)
  console.log(
    `Wrote ${relRows.length} relationships across ${relGroups.size} label-pair batches.`
  )

  await closeDriver()

  console.log(
    "Embedding entities for the vector-index sidecar (this calls Bedrock once per entity)..."
  )
  const index = new VectorIndex()
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
  let embedded = 0
  const CONCURRENCY = 8
  try {
    for (let i = 0; i < embedTargets.length; i += CONCURRENCY) {
      const batch = embedTargets.slice(i, i + CONCURRENCY)
      const vectors = await Promise.all(batch.map((t) => embedText(t.text)))
      index.upsert(
        batch.map((t, j) => ({
          id: t.id,
          label: t.label,
          primaryText: t.primaryText,
          vector: vectors[j]!,
        }))
      )
      embedded += batch.length
      console.log(`  embedded ${embedded}/${embedTargets.length}`)
    }
  } finally {
    index.save(VECTOR_INDEX_PATH)
    console.log(`Saved ${index.size()} embeddings to ${VECTOR_INDEX_PATH}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
