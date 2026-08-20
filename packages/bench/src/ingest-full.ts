import "dotenv/config"
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, type WriteStream } from "node:fs"
import { createInterface } from "node:readline"
import { createReadStream } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  chunkRowsBySize,
  createByogDatabase,
  createIdIndex,
  loadByogConfig,
  runQueryByog,
  truncateProperties,
  upsertNodesBatch,
  upsertRelationshipsBatch,
  type QuerySpec,
  type UpsertNodeRow,
  type UpsertRelationshipRow,
} from "@workspace/graph-client"
import { ContentStoreWriter } from "@workspace/vector-index"
import { loadQuestions, type RawDoc } from "./loader"
import { normalizeDoc, type NormalizedDoc } from "./adapt"

/**
 * Full-corpus EnterpriseRAG-Bench ingestion into a HydraDB Cloud BYOG
 * collection.
 *
 * This exists alongside ingest.ts rather than replacing it: ingest.ts loads the
 * committed 135-doc sample into the local node over Bolt and is the regression
 * fixture, so it stays untouched. Everything specific to 500k documents lives
 * here, and it differs from the sample path in four ways that all had to change
 * together for the load to be possible at all:
 *
 * 1. **Streaming, not batch.** The sample path holds every normalized doc, node
 *    row and relationship row in memory before writing anything. At 512k docs
 *    that is tens of GB and it OOMs. Here the corpus is processed in shards:
 *    normalize → write nodes → write relationships → drop. Only small
 *    cross-shard indexes persist (see MEMORY NOTES below).
 * 2. **Byte-measured batching.** Both transports cap the request *size*, not
 *    the row count (256 KiB on cloud). A fixed row count is what killed the
 *    previous attempt — 200 rows of full document bodies blew a 2 MiB cap.
 * 3. **Deterministic ids.** Ids are hashed from the entity's own natural key
 *    rather than handed out by an in-memory counter, so shard order, resume
 *    points and re-runs can never reassign an id and duplicate nodes. This is
 *    what makes the whole job restartable: every write is a MERGE on a stable
 *    id, so re-running is idempotent and a crash costs only the current shard.
 * 4. **Deferred embedding.** Node text is streamed to an embed-queue file
 *    instead of being embedded inline, so the graph is complete and queryable
 *    in minutes while the (much longer) Bedrock pass runs separately and
 *    resumably — see embed-full.ts.
 *
 * MEMORY NOTES — what is allowed to grow with corpus size:
 *   - `keyIndex`   (~700k) cross-document link resolution, key -> node id
 *   - `labelOfId`  (~512k) node id -> content label index, needed because a
 *                  relationship batch must name both endpoint labels
 *   - `writtenEntities` (~260k) dedupes Person/Org/Project/Channel across shards
 * Everything else is per-shard and dropped. Run with --max-old-space-size=8192.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR =
  process.env.BENCH_DATA_DIR ??
  join(__dirname, "..", "data", "enterprise-rag-bench-full", "generated_data")
const QUESTIONS_FILE = process.env.BENCH_QUESTIONS_FILE ?? "../questions.jsonl"
const WORK_DIR = process.env.BENCH_WORK_DIR ?? join(__dirname, "..", "data", "full-ingest")
/**
 * The content sidecar is written beside the vector index, not into the scratch
 * work dir: the work dir holds regenerable intermediates, while this is something
 * the running app reads at every request (see `attachBodyText`).
 */
const CONTENT_STORE_BASE =
  process.env.VECTOR_INDEX_FULL_PATH ?? join(__dirname, "..", "data", "vector-index.full.json")

/**
 * 256 KiB is the hard cap; the query text, the JSON envelope and any
 * multi-byte characters (JSON.stringify().length counts UTF-16 code units, the
 * cap is bytes) all come out of the same budget, so rows get ~70% of it.
 */
const MAX_BATCH_BYTES = 180 * 1024
const MAX_NODE_ROWS = 400
const MAX_REL_ROWS = 1200
/**
 * No batching can save a row that exceeds the whole request cap on its own, so
 * oversized properties are clipped rather than retried forever. With bodies held
 * in the content sidecar this only ever bites a pathological title/summary.
 */
const MAX_PROPERTY_CHARS = 8_000
const SHARD_SIZE = 4_000
const WRITE_CONCURRENCY = 12

/**
 * Properties holding document body text, which is written to the local content
 * sidecar instead of the graph.
 *
 * HydraDB Cloud is memory-resident and a first full-corpus attempt exhausted the
 * instance's `maxmemory` at ~54% of the corpus — every subsequent write failing
 * with "OOM command not allowed". Bodies are the bulk of those bytes and the part
 * no query ever touches: Graf filters, joins and traverses on ids, labels and
 * relationships, and only reads body text back out as evidence. Keeping bodies
 * out of the graph is what makes the full 511,962 documents fit; retrieval
 * re-attaches them from the sidecar after traversal (see
 * `packages/retrieval/src/body-text.ts`).
 */
const BODY_PROPERTIES = ["content", "description", "body", "text"] as const

const CONTENT_LABELS = ["Document", "Message", "Task", "Issue"] as const
const INDEXED_LABELS = [...CONTENT_LABELS, "Person", "Organization", "Project", "Channel"]

const ORG_NAME = "Redwood Inference"

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

/**
 * cyrb53 — a fast non-cryptographic 53-bit string hash. Ids must be stable
 * across runs and independent of iteration order (see header note 3), and they
 * must stay inside the float64 safe-integer range because HydraDB renders
 * 64-bit graph integers as JSON numbers and anything past 2^53 loses precision
 * on the way back.
 *
 * The result is folded into a 2^50 range offset by 10000, which reserves ids
 * below 10000 for the hand-authored seed-demo graph. Birthday collision odds
 * across ~1.5M keys in 2^50 are ~1 in 4000 — acceptable for a benchmark
 * corpus, where the cost of a collision is two nodes merging.
 */
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

const ID_SPACE = 2 ** 50
const ID_FLOOR = 10_000
function stableId(kind: string, key: string): number {
  return ID_FLOOR + (cyrb53(`${kind}:${key}`) % ID_SPACE)
}

// ---------------------------------------------------------------------------
// Corpus walking
// ---------------------------------------------------------------------------

/**
 * Lists every source document path. Uses withFileTypes so it never stats a
 * file individually — 512k separate statSync calls is minutes of pure syscall
 * overhead. Sorted so shard boundaries (and therefore resume points) are
 * identical on every run.
 */
function listSourceFiles(sourcesDir: string): string[] {
  const out: string[] = []
  const stack = [sourcesDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.endsWith(".json")) out.push(full)
    }
  }
  return out.sort()
}

function readDoc(file: string, sourcesDir: string): RawDoc | undefined {
  const relPath = file.slice(sourcesDir.length + 1)
  const sourceType = relPath.split("/")[0]!
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>
    return { dsid: (raw.dataset_doc_uuid as string) ?? relPath, sourceType, relPath, raw }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Cross-document link keys
// ---------------------------------------------------------------------------

/**
 * Decides whether a `knownKey` is distinctive enough to index for cross-link
 * resolution.
 *
 * The previous run produced 714,994 REFERENCES edges from 512k documents,
 * which is implausible: link resolution matches any 4+ character token in one
 * document's link fields against any other document's known keys, and those
 * link fields are things like `labels`, `tags`, `topics` and `components` —
 * ordinary words. At this corpus size any short key that happens to coincide
 * with a common word fans out across thousands of documents.
 *
 * Requiring 6+ characters *and* a digit keeps every real identifier shape in
 * the corpus (`dsid_…`, `INT-753159`, slack thread timestamps, meeting ids,
 * hubspot company ids) while dropping bare words and 4-digit counters.
 */
function isDistinctiveKey(key: string): boolean {
  return key.length >= 6 && /\d/.test(key)
}

/**
 * How many documents may declare the same key before it stops being treated as
 * an identifier at all.
 *
 * `isDistinctiveKey` filters by *shape*, which is necessary but not sufficient:
 * the first full-corpus load produced 7,376 REFERENCES edges from the single key
 * `123456` — a quarter of all cross-document edges came from its top 15 keys.
 * That key isn't an identifier, it's the fractional half of Slack thread
 * timestamps like `1699887766.123456`, which the tokenizer splits on the dot.
 *
 * Because a key resolved to one target id, every one of those 7,376 documents
 * got an edge to whichever document happened to declare the key last —
 * arbitrary, and worse than no edge, since a traversal that lands on it pulls an
 * unrelated document into the evidence set.
 *
 * A genuine identifier is declared by one document, or by the handful that are
 * the same thing across sources (an issue and the doc written about it) — which
 * is a link worth keeping, so up to this many declarers all get edges. Beyond
 * it, the key is a placeholder or a coincidence and is dropped entirely.
 */
const MAX_KEY_DECLARERS = 3

// ---------------------------------------------------------------------------
// Write pipeline
// ---------------------------------------------------------------------------

let requestsSent = 0
let rowsWritten = 0

/** Runs query specs against the cloud with bounded concurrency, surfacing failures loudly. */
async function runSpecs(specs: QuerySpec[], label: string): Promise<void> {
  let next = 0
  let failures = 0
  const workers = Array.from({ length: Math.min(WRITE_CONCURRENCY, specs.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= specs.length) return
      try {
        await runQueryByog(specs[i]!.query, specs[i]!.params)
        requestsSent++
      } catch (err) {
        failures++
        console.error(`  ${label}: batch ${i} failed permanently: ${(err as Error).message}`)
      }
    }
  })
  await Promise.all(workers)
  if (failures > 0) throw new Error(`${label}: ${failures}/${specs.length} batches failed after retries`)
}

function nodeSpecs(nodesByLabel: Map<string, UpsertNodeRow[]>): QuerySpec[] {
  const specs: QuerySpec[] = []
  for (const [label, rows] of nodesByLabel) {
    if (rows.length === 0) continue
    // The batch UNWIND builds its SET clause from the first row's keys, so a
    // batch has to be key-homogeneous. Every adapter for a given label happens
    // to emit the same property set today, but grouping by key signature keeps
    // that from being a silent correctness dependency.
    const bySignature = new Map<string, UpsertNodeRow[]>()
    for (const row of rows) {
      const signature = Object.keys(row).sort().join(",")
      const list = bySignature.get(signature) ?? []
      list.push(truncateProperties(row, MAX_PROPERTY_CHARS))
      bySignature.set(signature, list)
    }
    for (const group of bySignature.values()) {
      for (const batch of chunkRowsBySize(group, MAX_BATCH_BYTES, MAX_NODE_ROWS)) {
        specs.push(upsertNodesBatch(label, batch, { labelInMergePattern: true }))
        rowsWritten += batch.length
      }
    }
  }
  return specs
}

interface RelRow {
  relType: string
  sourceLabel: string
  destinationLabel: string
  row: UpsertRelationshipRow
}

function relSpecs(rels: RelRow[]): QuerySpec[] {
  // A batch can only cover one (relType, sourceLabel, destinationLabel) triple
  // — the UNWIND form has to name both endpoint labels in the pattern.
  const groups = new Map<string, RelRow[]>()
  for (const rel of rels) {
    const key = `${rel.relType}|${rel.sourceLabel}|${rel.destinationLabel}`
    const list = groups.get(key) ?? []
    list.push(rel)
    groups.set(key, list)
  }
  const specs: QuerySpec[] = []
  for (const [key, group] of groups) {
    const [relType, sourceLabel, destinationLabel] = key.split("|") as [string, string, string]
    for (const batch of chunkRowsBySize(group.map((r) => r.row), MAX_BATCH_BYTES, MAX_REL_ROWS)) {
      specs.push(upsertRelationshipsBatch(relType, sourceLabel, destinationLabel, batch))
      rowsWritten += batch.length
    }
  }
  return specs
}

// ---------------------------------------------------------------------------
// Checkpointing
// ---------------------------------------------------------------------------

interface Checkpoint {
  shardsDone: number
  phase: "nodes" | "references" | "done"
}

function loadCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return { shardsDone: 0, phase: "nodes" }
  return JSON.parse(readFileSync(path, "utf-8")) as Checkpoint
}

function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  writeFileSync(path, JSON.stringify(checkpoint), "utf-8")
}

function write(stream: WriteStream, line: string): Promise<void> | undefined {
  // Honour backpressure: 512k unflushed lines would otherwise buffer in memory
  // and undo the whole point of streaming.
  if (!stream.write(line)) return new Promise((resolve) => stream.once("drain", () => resolve()))
  return undefined
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = loadByogConfig()
  mkdirSync(WORK_DIR, { recursive: true })
  const linksPath = join(WORK_DIR, "links.jsonl")
  const embedQueuePath = join(WORK_DIR, "embed-queue.jsonl")
  const checkpointPath = join(WORK_DIR, "checkpoint.json")

  const sourcesDir = join(DATA_DIR, "sources")
  let files = listSourceFiles(sourcesDir)
  // Trial runs: cap the corpus (against a throwaway HYDRADB_BYOG_COLLECTION) to
  // validate the whole pipeline end to end before committing hours to it.
  const maxDocs = Number(process.env.BENCH_MAX_DOCS ?? 0)
  if (maxDocs > 0) {
    // Strided rather than the first N, so a capped run still spans every
    // source type instead of only the alphabetically-first one.
    const stride = Math.max(1, Math.floor(files.length / maxDocs))
    files = files.filter((_, i) => i % stride === 0).slice(0, maxDocs)
    console.log(`BENCH_MAX_DOCS=${maxDocs}: trial run over a strided subset.`)
  }
  const questions = loadQuestions(DATA_DIR, QUESTIONS_FILE)
  console.log(
    `Corpus: ${files.length} documents in ${sourcesDir}\n` +
      `Target: HydraDB Cloud ${config.baseUrl} database=${config.database} collection=${config.collection}\n` +
      `Questions: ${questions.length} from ${QUESTIONS_FILE}`
  )

  const checkpoint = loadCheckpoint(checkpointPath)
  if (checkpoint.shardsDone > 0) {
    console.log(`Resuming from checkpoint: ${checkpoint.shardsDone} shards already written, phase=${checkpoint.phase}.`)
  }

  await createByogDatabase({ config })
  console.log("Creating id indexes (every read filters on .id; without them each is a full label scan)...")
  for (const label of INDEXED_LABELS) {
    const spec = createIdIndex(label)
    try {
      await runQueryByog(spec.query, spec.params)
    } catch (err) {
      // Already-exists is the expected outcome on a resumed run.
      console.log(`  ${label}: ${(err as Error).message}`)
    }
  }

  // Cross-shard state. See MEMORY NOTES in the file header.
  const keyIndex = new Map<string, number>()
  // Keys declared by more than one document, kept out of `keyIndex` so a single
  // over-shared key can't resolve to an arbitrary one of its declarers. See
  // `MAX_KEY_DECLARERS`.
  const keyExtras = new Map<string, number[]>()
  const ambiguousKeys = new Set<string>()
  const labelOfId = new Map<number, number>()
  const writtenEntities = new Set<number>()

  /** Records that `docNodeId` declares `key`, demoting over-shared keys to ambiguous. */
  const recordKey = (key: string, docNodeId: number): void => {
    if (ambiguousKeys.has(key)) return
    const first = keyIndex.get(key)
    if (first === undefined) {
      keyIndex.set(key, docNodeId)
      return
    }
    if (first === docNodeId) return
    const extras = keyExtras.get(key)
    if (extras === undefined) {
      keyExtras.set(key, [docNodeId])
      return
    }
    if (extras.includes(docNodeId)) return
    if (2 + extras.length > MAX_KEY_DECLARERS) {
      // Give up on the key rather than pick a winner among its declarers.
      ambiguousKeys.add(key)
      keyIndex.delete(key)
      keyExtras.delete(key)
      return
    }
    extras.push(docNodeId)
  }

  /** All documents declaring `key`, empty when it was never seen or was too widely shared. */
  const resolveKey = (key: string): number[] => {
    const first = keyIndex.get(key)
    if (first === undefined) return []
    const extras = keyExtras.get(key)
    return extras === undefined ? [first] : [first, ...extras]
  }

  const orgRootId = stableId("org", ORG_NAME)
  // dsid -> label, but only for the handful of documents the conflicting_info
  // questions name, so CONTRADICTS can be written without keeping 512k labels.
  const conflictDsids = new Set<string>()
  for (const q of questions) {
    if (q.question_type === "conflicting_info" && q.expected_doc_ids.length === 2) {
      for (const id of q.expected_doc_ids) conflictDsids.add(id)
    }
  }
  const conflictLabels = new Map<string, string>()

  // Truncated even on a resumed run: every shard is re-normalized regardless
  // (the key indexes have to be complete before the REFERENCES pass), so
  // appending would duplicate every already-queued line.
  const linksStream = createWriteStream(linksPath, { flags: "w" })
  const embedStream = createWriteStream(embedQueuePath, { flags: "w" })
  const contentStore = new ContentStoreWriter(CONTENT_STORE_BASE)

  const totalShards = Math.ceil(files.length / SHARD_SIZE)
  const startedAt = Date.now()

  // The normalize loop runs on every invocation, including one whose checkpoint
  // says the node phase is already finished. It has to: `keyIndex`/`labelOfId`
  // must be complete before the REFERENCES pass, and the three streams opened
  // just above are rebuilt from it. Gating the loop on the phase would leave all
  // three truncated to zero — including the content sidecar the web app serves
  // body text from — so re-running a finished ingest would silently empty it.
  // Only the network writes are phase-dependent, via the `shardsDone` skip below.
  {
    for (let shard = 0; shard < totalShards; shard++) {
      const slice = files.slice(shard * SHARD_SIZE, (shard + 1) * SHARD_SIZE)

      // Normalize the shard. Even on a resumed run every shard is normalized,
      // because keyIndex/labelOfId must be complete before the REFERENCES pass
      // — only the network writes are skipped.
      const docs: NormalizedDoc[] = []
      for (const file of slice) {
        const raw = readDoc(file, sourcesDir)
        if (!raw) continue
        const doc = normalizeDoc(raw)
        if (doc) docs.push(doc)
      }

      const nodesByLabel = new Map<string, UpsertNodeRow[]>()
      const rels: RelRow[] = []
      const pushNode = (label: string, row: UpsertNodeRow) => {
        const list = nodesByLabel.get(label) ?? []
        list.push(row)
        nodesByLabel.set(label, list)
      }
      /** Returns the entity's stable id and whether this shard is the one creating it. */
      const ensureEntity = (
        label: string,
        key: string,
        row: Omit<UpsertNodeRow, "id" | "label">
      ): { id: number; created: boolean } => {
        const id = stableId(label.toLowerCase(), key)
        if (writtenEntities.has(id)) return { id, created: false }
        writtenEntities.add(id)
        pushNode(label, { id, label, ...row } as UpsertNodeRow)
        return { id, created: true }
      }

      if (shard === 0 && !writtenEntities.has(orgRootId)) {
        writtenEntities.add(orgRootId)
        pushNode("Organization", {
          id: orgRootId,
          label: "Organization",
          primary_text: ORG_NAME,
          name: ORG_NAME,
          kind: "internal",
        })
      }

      for (const doc of docs) {
        const docNodeId = stableId("doc", doc.dsid)
        labelOfId.set(docNodeId, CONTENT_LABELS.indexOf(doc.label))
        if (conflictDsids.has(doc.dsid)) conflictLabels.set(doc.dsid, doc.label)

        // Body text goes to the sidecar, everything the graph can query stays on
        // the node. Splitting here (rather than deleting keys after the fact)
        // keeps a shard's node rows key-homogeneous, which the batch UNWIND needs.
        const graphProperties: Record<string, string | number | boolean> = {}
        const bodyParts: string[] = []
        for (const [key, value] of Object.entries(doc.properties)) {
          if ((BODY_PROPERTIES as readonly string[]).includes(key)) {
            if (typeof value === "string" && value) bodyParts.push(value)
          } else {
            graphProperties[key] = value
          }
        }
        const body = bodyParts.join("\n\n")
        if (body) await contentStore.append(docNodeId, body)

        pushNode(doc.label, {
          id: docNodeId,
          label: doc.label,
          primary_text: doc.primaryText,
          dsid: doc.dsid,
          ...graphProperties,
        })

        for (const key of doc.knownKeys) {
          if (isDistinctiveKey(key)) recordKey(key.toLowerCase(), docNodeId)
        }

        for (const person of doc.people) {
          const { id: personId, created } = ensureEntity("Person", person.name, {
            primary_text: person.name,
            name: person.name,
            source: "bench",
          })
          // One MEMBER_OF per person, emitted with the person's own node rather
          // than once per document that mentions them.
          if (created) {
            rels.push({
              relType: "MEMBER_OF",
              sourceLabel: "Person",
              destinationLabel: "Organization",
              row: { id: stableId("member_of", String(personId)), rel_type: "MEMBER_OF", sourceId: personId, destinationId: orgRootId },
            })
          }
          const authored = person.relation === "AUTHORED"
          rels.push({
            relType: person.relation,
            sourceLabel: authored ? "Person" : doc.label,
            destinationLabel: authored ? doc.label : "Person",
            row: {
              id: stableId(person.relation, `${personId}|${docNodeId}`),
              rel_type: person.relation,
              sourceId: authored ? personId : docNodeId,
              destinationId: authored ? docNodeId : personId,
            },
          })
        }

        if (doc.projectKey) {
          const { id: projectId } = ensureEntity("Project", doc.projectKey, {
            primary_text: doc.projectKey,
            name: doc.projectKey,
            summary: "",
            status: "",
          })
          rels.push({
            relType: "PART_OF",
            sourceLabel: doc.label,
            destinationLabel: "Project",
            row: { id: stableId("part_of", `${docNodeId}|${projectId}`), rel_type: "PART_OF", sourceId: docNodeId, destinationId: projectId },
          })
        }

        if (doc.channelKey) {
          const { id: channelId } = ensureEntity("Channel", doc.channelKey, {
            primary_text: doc.channelKey,
            name: doc.channelKey,
            source: "slack",
          })
          rels.push({
            relType: "DISCUSSED_IN",
            sourceLabel: doc.label,
            destinationLabel: "Channel",
            row: { id: stableId("discussed_in", `${docNodeId}|${channelId}`), rel_type: "DISCUSSED_IN", sourceId: docNodeId, destinationId: channelId },
          })
        }

        if (doc.companyName) {
          const { id: companyId } = ensureEntity("Organization", doc.companyName, {
            primary_text: doc.companyName,
            name: doc.companyName,
            kind: "customer",
          })
          rels.push({
            relType: "REFERENCES",
            sourceLabel: doc.label,
            destinationLabel: "Organization",
            row: { id: stableId("references_org", `${docNodeId}|${companyId}`), rel_type: "REFERENCES", sourceId: docNodeId, destinationId: companyId },
          })
        }

        if (doc.linkTexts.length > 0) {
          await write(linksStream, `${JSON.stringify({ i: docNodeId, l: doc.label, t: doc.linkTexts })}\n`)
        }

        const embedText = [doc.primaryText, body].filter(Boolean).join("\n").slice(0, 4000)
        if (embedText.trim()) {
          await write(embedStream, `${JSON.stringify({ id: docNodeId, label: doc.label, primaryText: doc.primaryText, text: embedText })}\n`)
        }
      }

      // Entity nodes queued this shard also need embedding — they are the pool
      // entity resolution searches, so skipping them would break "Sam" -> the
      // right Sam at corpus scale.
      for (const [label, rows] of nodesByLabel) {
        if ((CONTENT_LABELS as readonly string[]).includes(label)) continue
        for (const row of rows) {
          await write(embedStream, `${JSON.stringify({ id: row.id, label, primaryText: row.primary_text, text: String(row.primary_text) })}\n`)
        }
      }

      if (shard < checkpoint.shardsDone) continue // already written; we only needed the indexes

      await runSpecs(nodeSpecs(nodesByLabel), `shard ${shard} nodes`)
      await runSpecs(relSpecs(rels), `shard ${shard} rels`)

      saveCheckpoint(checkpointPath, { shardsDone: shard + 1, phase: "nodes" })
      const elapsed = (Date.now() - startedAt) / 1000
      const done = shard + 1
      const rate = done / elapsed
      console.log(
        `shard ${done}/${totalShards} (${(done * SHARD_SIZE).toLocaleString()} docs) — ` +
          `${rowsWritten.toLocaleString()} rows, ${requestsSent.toLocaleString()} requests, ` +
          `${elapsed.toFixed(0)}s elapsed, eta ${((totalShards - done) / rate / 60).toFixed(1)}min`
      )
    }
    if (checkpoint.phase === "nodes") saveCheckpoint(checkpointPath, { shardsDone: totalShards, phase: "references" })
  }

  linksStream.end()
  embedStream.end()
  await contentStore.close()
  console.log(
    `Nodes and direct relationships written. keyIndex=${keyIndex.size.toLocaleString()} distinctive keys ` +
      `(${keyExtras.size.toLocaleString()} shared by 2-${MAX_KEY_DECLARERS} documents, ` +
      `${ambiguousKeys.size.toLocaleString()} dropped as too widely shared), ` +
      `${contentStore.size.toLocaleString()} body texts in the content sidecar.`
  )

  // -------------------------------------------------------------------------
  // Cross-document REFERENCES
  // -------------------------------------------------------------------------
  console.log("Resolving cross-document REFERENCES from link text...")
  const fanout = new Map<string, number>()
  let referenceCount = 0
  let pending: RelRow[] = []

  const rl = createInterface({ input: createReadStream(linksPath), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    const { i: sourceId, l: sourceLabel, t: linkTexts } = JSON.parse(line) as { i: number; l: string; t: string[] }
    const seen = new Set<number>()
    for (const text of linkTexts) {
      for (const token of text.toLowerCase().match(/[a-z0-9_-]{6,}/g) ?? []) {
        for (const targetId of resolveKey(token)) {
          if (targetId === sourceId || seen.has(targetId)) continue
          seen.add(targetId)
          const labelIdx = labelOfId.get(targetId)
          if (labelIdx === undefined || labelIdx < 0) continue
          fanout.set(token, (fanout.get(token) ?? 0) + 1)
          pending.push({
            relType: "REFERENCES",
            sourceLabel,
            destinationLabel: CONTENT_LABELS[labelIdx]!,
            row: { id: stableId("references", `${sourceId}|${targetId}`), rel_type: "REFERENCES", sourceId, destinationId: targetId },
          })
          referenceCount++
        }
      }
    }
    if (pending.length >= 20_000) {
      await runSpecs(relSpecs(pending), "references")
      pending = []
      console.log(`  ${referenceCount.toLocaleString()} REFERENCES edges written`)
    }
  }
  if (pending.length > 0) await runSpecs(relSpecs(pending), "references")

  // Fan-out report: the previous attempt's 714,994 edges were never validated,
  // and a single over-matching key is exactly how that number gets inflated.
  const topFanout = Array.from(fanout.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15)
  console.log(
    `Resolved ${referenceCount.toLocaleString()} cross-document REFERENCES edges.\n` +
      `Highest fan-out keys (inspect for false positives):\n` +
      topFanout.map(([key, n]) => `  ${key}: ${n}`).join("\n")
  )

  // -------------------------------------------------------------------------
  // Ground-truth CONTRADICTS
  // -------------------------------------------------------------------------
  const contradictions: RelRow[] = []
  for (const q of questions) {
    if (q.question_type !== "conflicting_info" || q.expected_doc_ids.length !== 2) continue
    const [aDsid, bDsid] = q.expected_doc_ids as [string, string]
    const aLabel = conflictLabels.get(aDsid)
    const bLabel = conflictLabels.get(bDsid)
    if (!aLabel || !bLabel) continue
    const aId = stableId("doc", aDsid)
    const bId = stableId("doc", bDsid)
    contradictions.push({
      relType: "CONTRADICTS",
      sourceLabel: aLabel,
      destinationLabel: bLabel,
      row: {
        id: stableId("contradicts", `${aId}|${bId}`),
        rel_type: "CONTRADICTS",
        sourceId: aId,
        destinationId: bId,
        source_question: q.question_id,
      },
    })
  }
  if (contradictions.length > 0) await runSpecs(relSpecs(contradictions), "contradicts")
  console.log(`Added ${contradictions.length} CONTRADICTS edges from conflicting_info questions.`)

  saveCheckpoint(checkpointPath, { shardsDone: totalShards, phase: "done" })
  console.log(
    `\nDone in ${((Date.now() - startedAt) / 60000).toFixed(1)} min — ` +
      `${rowsWritten.toLocaleString()} rows over ${requestsSent.toLocaleString()} requests.\n` +
      `Embed queue: ${embedQueuePath}\nNext: pnpm --filter @workspace/bench run embed:full`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
