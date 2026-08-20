import "dotenv/config"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { answerQuestion } from "@workspace/retrieval"

/**
 * Runs @workspace/retrieval's full pipeline over the same 55 sample
 * questions baseline-vector-rag.ts answers, so `bench:eval` can score the
 * graph-retrieval side of the comparison. document_ids come from the `dsid`
 * property ingest.ts stamps on every bench content node — restricted to
 * nodes the answer actually cited (claims[].supportingNodeIds), not every
 * node touched during traversal, so "Invalid Extra Documents" reflects real
 * over-citation rather than incidental hops.
 */

const dataDir = path.resolve(fileURLToPath(import.meta.url), "../../data")
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 4)
/**
 * Defaults to the committed sample so the comparison in README.md stays
 * reproducible with no env set; override both to score the full-corpus load
 * (`enterprise-rag-bench-full/questions.jsonl`, all 500 gold questions) without
 * overwriting the sample results the README's numbers refer to.
 */
const QUESTIONS_PATH =
  process.env.BENCH_QUESTIONS_PATH ?? path.join(dataDir, "enterprise-rag-bench-sample", "questions.sample.jsonl")
const OUT_PATH = process.env.BENCH_ANSWERS_OUT ?? path.join(dataDir, "graph-retrieval-answers.sample.jsonl")
const LIMIT = Number(process.env.BENCH_QUESTION_LIMIT ?? 0)

interface BenchQuestion {
  question_id: string
  question: string
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}

async function main() {
  let questions: BenchQuestion[] = readFileSync(QUESTIONS_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  if (LIMIT > 0) questions = questions.slice(0, LIMIT)
  console.log(`${questions.length} questions from ${QUESTIONS_PATH} at concurrency ${CONCURRENCY}`)

  let done = 0
  const lines = await mapLimit(questions, CONCURRENCY, async (q) => {
    try {
      const result = await answerQuestion(q.question, "normal")
      // Report every content node the retrieval touched (not only ones a
      // claim explicitly cites) — this is "what did retrieval consider",
      // matching how the vector-RAG baseline reports its top-K set. Scores
      // higher on recall/correctness than an evidence-only citation set,
      // at the cost of more invalid-extra-documents noise (see README).
      const documentIds = Array.from(
        new Set(result.nodes.map((n) => n.properties.dsid).filter((v): v is string => typeof v === "string"))
      )
      done++
      console.log(`[${done}/${questions.length}] ${q.question_id} — ${documentIds.length} cited docs`)
      return JSON.stringify({ question_id: q.question_id, answer: result.answer, document_ids: documentIds })
    } catch (err) {
      done++
      console.error(`[${done}/${questions.length}] ${q.question_id} FAILED:`, err instanceof Error ? err.message : err)
      return JSON.stringify({ question_id: q.question_id, answer: "", document_ids: [] })
    }
  })

  writeFileSync(OUT_PATH, lines.join("\n") + "\n")
  console.log(`wrote ${lines.length} answers to ${OUT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
