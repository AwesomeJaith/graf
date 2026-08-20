import "dotenv/config"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { loadQuestions, type BenchQuestion } from "./loader"
import {
  documentRecall,
  invalidExtraDocuments,
  judgeCompleteness,
  judgeCorrectness,
} from "./judge"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR =
  process.env.BENCH_DATA_DIR ??
  join(__dirname, "..", "data", "enterprise-rag-bench-sample")

interface AnswerRow {
  question_id: string
  answer?: string
  document_ids?: string[]
}

interface QuestionResult {
  question_id: string
  question_type: string
  correct?: boolean
  completeness?: number
  documentRecall?: number
  invalidExtraDocuments?: number
}

function loadAnswers(path: string): Map<string, AnswerRow> {
  const rows = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AnswerRow)
  return new Map(rows.map((r) => [r.question_id, r]))
}

function mean(nums: number[]): number | undefined {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined
}

async function evalQuestion(
  q: BenchQuestion,
  answer: AnswerRow | undefined
): Promise<QuestionResult> {
  const base: QuestionResult = {
    question_id: q.question_id,
    question_type: q.question_type,
  }
  if (!answer?.answer) return base
  const docMetrics = {
    documentRecall: documentRecall(q.expected_doc_ids, answer.document_ids ?? []),
    invalidExtraDocuments: invalidExtraDocuments(q.expected_doc_ids, answer.document_ids ?? []),
  }
  try {
    const [correctness, completeness] = await Promise.all([
      judgeCorrectness(q.question, q.gold_answer, answer.answer),
      judgeCompleteness(answer.answer, q.answer_facts),
    ])
    return { ...base, correct: correctness.correct, completeness, ...docMetrics }
  } catch (err) {
    // One malformed judge response (occasionally an unescaped quote inside
    // the model's own "reasoning" string breaks strict JSON parsing) drops
    // that question's correctness/completeness rather than crashing the
    // whole batch — document metrics don't depend on the judge call.
    console.error(`judge failed for ${q.question_id}:`, err instanceof Error ? err.message : err)
    return { ...base, ...docMetrics }
  }
}

async function main() {
  const answersPath = process.argv[2]
  const label =
    process.argv[3] ??
    answersPath
      ?.split("/")
      .pop()
      ?.replace(/\.jsonl?$/, "") ??
    "system"
  if (!answersPath) {
    console.error("Usage: tsx src/run-eval.ts <answers.jsonl> [label]")
    process.exit(1)
  }

  const questions = loadQuestions(DATA_DIR)
  const answers = loadAnswers(answersPath)

  const CONCURRENCY = 6
  const results: QuestionResult[] = []
  for (let i = 0; i < questions.length; i += CONCURRENCY) {
    const batch = questions.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map((q) => evalQuestion(q, answers.get(q.question_id)))
    )
    results.push(...batchResults)
    console.log(
      `Evaluated ${Math.min(i + CONCURRENCY, questions.length)}/${questions.length}`
    )
  }

  const byCategory = new Map<string, QuestionResult[]>()
  for (const r of results) {
    const list = byCategory.get(r.question_type) ?? []
    list.push(r)
    byCategory.set(r.question_type, list)
  }

  const summarize = (rs: QuestionResult[]) => ({
    count: rs.length,
    answered: rs.filter((r) => r.correct !== undefined).length,
    correctness: mean(
      rs.filter((r) => r.correct !== undefined).map((r) => (r.correct ? 1 : 0))
    ),
    completeness: mean(
      rs.map((r) => r.completeness).filter((v): v is number => v !== undefined)
    ),
    documentRecall: mean(
      rs
        .map((r) => r.documentRecall)
        .filter((v): v is number => v !== undefined)
    ),
    invalidExtraDocuments: mean(
      rs
        .map((r) => r.invalidExtraDocuments)
        .filter((v): v is number => v !== undefined)
    ),
  })

  const report = {
    label,
    answersPath,
    overall: summarize(results),
    byCategory: Object.fromEntries(
      [...byCategory.entries()].map(([cat, rs]) => [cat, summarize(rs)])
    ),
    questions: results,
  }

  const outDir = join(__dirname, "..", "data", "results")
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${label}.json`)
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8")

  console.log(`\n=== ${label} ===`)
  console.log(
    `overall: correctness=${fmt(report.overall.correctness)} completeness=${fmt(report.overall.completeness)} docRecall=${fmt(report.overall.documentRecall)} invalidExtra=${report.overall.invalidExtraDocuments?.toFixed(2) ?? "n/a"} (${report.overall.answered}/${report.overall.count} answered)`
  )
  for (const [cat, s] of Object.entries(report.byCategory)) {
    console.log(
      `  ${cat.padEnd(26)} correctness=${fmt(s.correctness)} completeness=${fmt(s.completeness)} docRecall=${fmt(s.documentRecall)} (${s.answered}/${s.count})`
    )
  }
  console.log(`\nWrote ${outPath}`)
}

function fmt(v: number | undefined): string {
  return v === undefined ? "n/a" : `${(v * 100).toFixed(0)}%`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
