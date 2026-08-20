import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime"

let client: BedrockRuntimeClient | undefined

function getClient(): BedrockRuntimeClient {
  if (!client)
    client = new BedrockRuntimeClient({ region: process.env.AWS_REGION })
  return client
}

/** One-shot text completion via Bedrock Converse. Used only by the eval judges below — the retrieval pipeline has its own LLM client. */
export async function chat(
  system: string,
  user: string,
  modelId = process.env.BEDROCK_FAST_MODEL_ID
): Promise<string> {
  if (!modelId)
    throw new Error(
      "BEDROCK_FAST_MODEL_ID (or an explicit modelId) is required."
    )
  const response = await getClient().send(
    new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: user }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0 },
    })
  )
  return response.output?.message?.content?.[0]?.text ?? ""
}

/**
 * Extracts the first balanced {...} JSON object out of a judge response,
 * tolerating stray prose before/after it. A regex can't do this reliably —
 * both a greedy match (swallows unrelated braces in trailing prose) and a
 * naive non-greedy match (cuts off early on a `}` that appears inside a
 * string field, e.g. inside "reasoning") produce invalid JSON. This walks
 * the string tracking brace depth and string/escape state instead.
 */
export function extractJson<T>(text: string): T {
  const start = text.indexOf("{")
  if (start === -1)
    throw new Error(`No JSON found in judge response: ${text.slice(0, 200)}`)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as T
    }
  }
  throw new Error(`Unbalanced JSON in judge response: ${text.slice(0, 200)}`)
}
