import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime"

let client: BedrockRuntimeClient | undefined

function getClient(): BedrockRuntimeClient {
  if (!client) client = new BedrockRuntimeClient({ region: process.env.AWS_REGION })
  return client
}

/** One-shot text completion via Bedrock Converse. Used only by the eval judges below — the retrieval pipeline has its own LLM client. */
export async function chat(system: string, user: string, modelId = process.env.BEDROCK_FAST_MODEL_ID): Promise<string> {
  if (!modelId) throw new Error("BEDROCK_FAST_MODEL_ID (or an explicit modelId) is required.")
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
 * Parses the first {...} JSON object out of a judge response, tolerating
 * stray prose before/after it. Non-greedy — our judge schemas are always
 * flat single-level objects, so the first `{` to the first following `}` is
 * the whole thing; a greedy match risks swallowing unrelated braces the
 * model adds in surrounding explanation text.
 */
export function extractJson<T>(text: string): T {
  const match = text.match(/\{[\s\S]*?\}/)
  if (!match) throw new Error(`No JSON found in judge response: ${text.slice(0, 200)}`)
  return JSON.parse(match[0]) as T
}
