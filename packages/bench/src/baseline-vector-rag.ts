import "dotenv/config"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { writeFileSync } from "node:fs"
import { embedText, loadContentStore, loadVectorIndex } from "@workspace/vector-index"
import { runGraphQuery } from "@workspace/graph-client"
import { chat } from "./bedrock-chat"
import { loadRawDocs, loadQuestions } from "./loader"
import { normalizeDoc, type NormalizedDoc } from "./adapt"

/**
 * "Baseline vector/standard RAG" comparison point from prompt.md: no graph,
 * no entity resolution, no traversal — embed every document, embed the
 * question, cosine-rank, stuff the top-K into an LLM call. This is the thing
 * graph retrieval (packages/retrieval) needs to beat, category by category.
 *
 * Two modes, same prompt and same top-K so the two are comparable:
 *
 * - default: embeds every document in DATA_DIR at run time. Correct and
 *   self-contained, but it re-embeds the corpus on every run — fine for the
 *   135-document sample, hours and a second full embedding bill for 511,962.
 * - `--from-index`: ranks against the sidecar embeddings `bench:embed:full`
 *   already built, which is the only way this baseline runs at full-corpus
 *   scale at all. Bodies come from the content sidecar rather than re-reading
 *   the source tree.
 *
 * `--from-index` does issue one graph query per question, purely to translate
 * the ranked node ids back into the `dsid`s the eval scores on — no traversal,
 * no neighbors, nothing that could give the baseline any of the graph's
 * advantage. It's bookkeeping, not retrieval. The one real asymmetry to keep in
 * mind when reading the numbers: the sidecar's vectors were built from
 * `[primaryText, body].slice(0, 4000)` during ingest, so this mode ranks on the
 * same text the default mode's `docText()` truncates to, but embedded once by
 * the ingest rather than freshly here.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR =
  process.env.BENCH_DATA_DIR ??
  join(__dirname, "..", "data", "enterprise-rag-bench-sample")
const OUT_PATH =
  process.argv.slice(2).find((a) => !a.startsWith("--")) ??
  join(__dirname, "..", "data", "baseline-answers.sample.jsonl")
const TOP_K = 5
const FROM_INDEX = process.argv.includes("--from-index")
/** The labels that carry a `dsid`; Person/Project/Organization aren't documents. */
const CONTENT_LABELS = ["Document", "Message", "Task", "Issue"]

function docText(doc: NormalizedDoc): string {
  const { title, content, description, body, text } = doc.properties as Record<
    string,
    string
  >
  return [doc.primaryText, title, content, description, body, text]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000)
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

const ANSWER_SYSTEM =
  "Answer the question using ONLY the documents provided below. If the documents don't contain the answer, say you could not find it. Be concise."

/**
 * Ranks against the embeddings the ingest already built. Only content labels
 * are searched — the index also holds Person/Project/Organization vectors, and
 * a baseline that "retrieves" a Person node has nothing to answer from and no
 * `dsid` to score.
 */
async function runFromIndex(): Promise<void> {
  const indexPath = process.env.VECTOR_INDEX_PATH
  if (!indexPath) throw new Error("VECTOR_INDEX_PATH must be set to run with --from-index.")
  const index = loadVectorIndex(indexPath)
  const contentStore = loadContentStore(indexPath)
  if (index.size() === 0) throw new Error(`No embeddings at ${indexPath} — run bench:embed:full first.`)
  const questions = loadQuestions(DATA_DIR, process.env.BENCH_QUESTIONS_FILE ?? "questions.sample.jsonl")
  console.log(`Ranking ${questions.length} questions against ${index.size().toLocaleString()} sidecar embeddings`)

  const lines: string[] = []
  for (const [i, q] of questions.entries()) {
    const qVector = await embedText(q.question)
    const ranked = index.search(qVector, { topK: TOP_K, labels: CONTENT_LABELS })

    // One query, purely id -> dsid. Grouped by label because a labelless MATCH
    // can't use the id index (see traverse.ts).
    const dsidById = new Map<number, string>()
    const byLabel = new Map<string, number[]>()
    for (const m of ranked) byLabel.set(m.label, [...(byLabel.get(m.label) ?? []), m.id])
    await Promise.all(
      Array.from(byLabel.entries()).map(async ([label, ids]) => {
        try {
          const rows = await runGraphQuery(
            `UNWIND $ids AS wanted MATCH (n:${label}) WHERE n.id = wanted RETURN n.id AS id, n.dsid AS dsid`,
            { ids }
          )
          for (const row of rows) {
            if (typeof row.id === "number" && typeof row.dsid === "string") dsidById.set(row.id, row.dsid)
          }
        } catch {
          // A missing dsid costs this question recall credit rather than failing the run.
        }
      })
    )

    const context = ranked
      .map((m, k) => `[Doc ${k + 1}] ${[m.primaryText, contentStore?.get(m.id) ?? ""].filter(Boolean).join("\n").slice(0, 4000)}`)
      .join("\n\n")
    const answer = await chat(ANSWER_SYSTEM, `Documents:\n${context}\n\nQuestion: ${q.question}`)

    lines.push(
      JSON.stringify({
        question_id: q.question_id,
        answer,
        document_ids: ranked.map((m) => dsidById.get(m.id)).filter((d): d is string => Boolean(d)),
      })
    )
    console.log(`${i + 1}/${questions.length} ${q.question_id} (${q.question_type})`)
  }

  writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf-8")
  console.log(`Wrote ${lines.length} baseline answers to ${OUT_PATH}`)
}

async function main() {
  if (FROM_INDEX) return runFromIndex()

  const docs = loadRawDocs(DATA_DIR)
    .map(normalizeDoc)
    .filter((d): d is NormalizedDoc => Boolean(d))
  const questions = loadQuestions(DATA_DIR)
  console.log(`Embedding ${docs.length} documents for the baseline index...`)
  const docVectors = await Promise.all(
    docs.map((d) => embedText(docText(d) || d.primaryText || d.sourceType))
  )

  const lines: string[] = []
  for (const [i, q] of questions.entries()) {
    const qVector = await embedText(q.question)
    const ranked = docs
      .map((d, j) => ({ doc: d, score: cosine(qVector, docVectors[j]!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)

    const context = ranked
      .map((r, k) => `[Doc ${k + 1}] ${docText(r.doc)}`)
      .join("\n\n")
    const answer = await chat(ANSWER_SYSTEM, `Documents:\n${context}\n\nQuestion: ${q.question}`)

    lines.push(
      JSON.stringify({
        question_id: q.question_id,
        answer,
        document_ids: ranked.map((r) => r.doc.dsid),
      })
    )
    console.log(
      `${i + 1}/${questions.length} ${q.question_id} (${q.question_type})`
    )
  }

  writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf-8")
  console.log(`Wrote ${lines.length} baseline answers to ${OUT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
