import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export interface RawDoc {
  dsid: string
  sourceType: string
  relPath: string
  raw: Record<string, unknown>
}

export interface BenchQuestion {
  question_id: string
  question_type: string
  source_types: string[]
  question: string
  expected_doc_ids: string[]
  gold_answer: string
  answer_facts: string[]
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith(".json")) out.push(full)
  }
  return out
}

/**
 * Loads the curated EnterpriseRAG-Bench sample (see data/enterprise-rag-bench-sample)
 * — a connected slice of the ~512k-document corpus selected to cover every
 * question category and every source type while staying small enough to
 * ingest and commit. See packages/bench/README.md for how it was chosen.
 */
export function loadRawDocs(dataDir: string): RawDoc[] {
  const sourcesDir = join(dataDir, "sources")
  const files = walk(sourcesDir)
  const docs: RawDoc[] = []
  for (const file of files) {
    const relPath = file.slice(sourcesDir.length + 1)
    const sourceType = relPath.split("/")[0]!
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(file, "utf-8"))
    } catch {
      continue
    }
    const dsid = (raw.dataset_doc_uuid as string) ?? relPath
    docs.push({ dsid, sourceType, relPath, raw })
  }
  return docs
}

export function loadQuestions(dataDir: string, filename = "questions.sample.jsonl"): BenchQuestion[] {
  const path = join(dataDir, filename)
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BenchQuestion)
}
