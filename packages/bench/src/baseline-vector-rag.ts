import "dotenv/config"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { writeFileSync } from "node:fs"
import { embedText } from "@workspace/vector-index"
import { chat } from "./bedrock-chat"
import { loadRawDocs, loadQuestions } from "./loader"
import { normalizeDoc, type NormalizedDoc } from "./adapt"

/**
 * "Baseline vector/standard RAG" comparison point from prompt.md: no graph,
 * no entity resolution, no traversal — embed every document, embed the
 * question, cosine-rank, stuff the top-K into an LLM call. This is the thing
 * graph retrieval (packages/retrieval) needs to beat, category by category.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BENCH_DATA_DIR ?? join(__dirname, "..", "data", "enterprise-rag-bench-sample")
const OUT_PATH = process.argv[2] ?? join(__dirname, "..", "data", "baseline-answers.sample.jsonl")
const TOP_K = 5

function docText(doc: NormalizedDoc): string {
  const { title, content, description, body, text } = doc.properties as Record<string, string>
  return [doc.primaryText, title, content, description, body, text].filter(Boolean).join("\n").slice(0, 4000)
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

async function main() {
  const docs = loadRawDocs(DATA_DIR)
    .map(normalizeDoc)
    .filter((d): d is NormalizedDoc => Boolean(d))
  const questions = loadQuestions(DATA_DIR)
  console.log(`Embedding ${docs.length} documents for the baseline index...`)
  const docVectors = await Promise.all(docs.map((d) => embedText(docText(d) || d.primaryText || d.sourceType)))

  const lines: string[] = []
  for (const [i, q] of questions.entries()) {
    const qVector = await embedText(q.question)
    const ranked = docs
      .map((d, j) => ({ doc: d, score: cosine(qVector, docVectors[j]!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)

    const context = ranked.map((r, k) => `[Doc ${k + 1}] ${docText(r.doc)}`).join("\n\n")
    const answer = await chat(
      "Answer the question using ONLY the documents provided below. If the documents don't contain the answer, say you could not find it. Be concise.",
      `Documents:\n${context}\n\nQuestion: ${q.question}`
    )

    lines.push(JSON.stringify({ question_id: q.question_id, answer, document_ids: ranked.map((r) => r.doc.dsid) }))
    console.log(`${i + 1}/${questions.length} ${q.question_id} (${q.question_type})`)
  }

  writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf-8")
  console.log(`Wrote ${lines.length} baseline answers to ${OUT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
