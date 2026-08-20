import { chat, extractJson } from "./bedrock-chat"

/**
 * Simplified metrics-based eval, modeled on EnterpriseRAG-Bench's own
 * quickstart.md (Correctness / Completeness / Document Recall / Invalid
 * Extra Documents) but with a single LLM judge instead of their 3-judge
 * consensus + gold-correction flow — appropriate for a hackathon-scale
 * comparison, not a leaderboard submission.
 */

export interface CorrectnessVerdict {
  correct: boolean
  reasoning: string
}

export async function judgeCorrectness(question: string, goldAnswer: string, candidateAnswer: string): Promise<CorrectnessVerdict> {
  const system =
    "You are grading a candidate answer against a gold answer for a question-answering benchmark. " +
    "Be lenient toward stylistic differences, additional context, and extra detail, but the candidate must address " +
    "the core aspects of the question and must not conflict with the gold answer. Specific quantities/dates/values " +
    "mentioned in the gold answer must match in the candidate if the candidate mentions them at all. " +
    'Respond with ONLY a JSON object: {"correct": boolean, "reasoning": "one sentence"}'
  const user = `Question: ${question}\n\nGold answer: ${goldAnswer}\n\nCandidate answer: ${candidateAnswer}`
  const text = await chat(system, user)
  return extractJson<CorrectnessVerdict>(text)
}

export interface FactVerdict {
  fact: string
  supported: boolean
}

export async function judgeFactSupported(candidateAnswer: string, fact: string): Promise<FactVerdict> {
  const system =
    "You check whether a candidate answer contains or implies a specific fact. " +
    'Respond with ONLY a JSON object: {"supported": boolean}'
  const user = `Fact to check: ${fact}\n\nCandidate answer: ${candidateAnswer}`
  const text = await chat(system, user)
  const { supported } = extractJson<{ supported: boolean }>(text)
  return { fact, supported }
}

export async function judgeCompleteness(candidateAnswer: string, answerFacts: string[]): Promise<number> {
  if (answerFacts.length === 0) return 1
  const verdicts = await Promise.all(answerFacts.map((f) => judgeFactSupported(candidateAnswer, f)))
  return verdicts.filter((v) => v.supported).length / verdicts.length
}

export function documentRecall(expectedDocIds: string[], candidateDocIds: string[]): number | undefined {
  if (expectedDocIds.length === 0) return undefined
  const candidateSet = new Set(candidateDocIds)
  const hits = expectedDocIds.filter((id) => candidateSet.has(id)).length
  return hits / expectedDocIds.length
}

/** Simplified: any candidate doc outside the gold set counts as "invalid extra" — the real benchmark runs a 3-judge relevance classification instead of a strict set difference. */
export function invalidExtraDocuments(expectedDocIds: string[], candidateDocIds: string[]): number | undefined {
  if (expectedDocIds.length === 0) return undefined
  const expectedSet = new Set(expectedDocIds)
  return candidateDocIds.filter((id) => !expectedSet.has(id)).length
}
