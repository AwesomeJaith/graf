import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime"
import type { DocumentType } from "@smithy/types"

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
      // 1024 truncates mid-JSON on judge responses with long reasoning
      // (e.g. "constrained" questions with many negative facts to check),
      // which extractJson can't recover from since the object never closes.
      inferenceConfig: { maxTokens: 4096, temperature: 0 },
    })
  )
  return response.output?.message?.content?.[0]?.text ?? ""
}

/**
 * A judge verdict, as a forced tool call rather than JSON asked for in prose.
 *
 * Asking for `{"correct": ..., "reasoning": ...}` as text and parsing it back
 * cost two questions of the full-corpus run: the model closed the reasoning
 * string with a doubled quote (`...fallback.""}`), so any brace-depth parser
 * reads the final `}` as still inside a string and the object never closes.
 * That's not a fixable parser bug — hand-written JSON from a model has an
 * open-ended set of ways to be almost-valid, and each one silently drops a
 * question from the denominator.
 *
 * `toolChoice` makes the model fill a schema the SDK hands back already
 * parsed, so there's no text to parse and nothing to be malformed. Same
 * mechanism the retrieval pipeline uses; kept separate from it because the
 * judges run on BEDROCK_FAST_MODEL_ID, deliberately not the model under test.
 */
export async function chatStructured<T>(
  system: string,
  user: string,
  tool: { name: string; description: string; inputSchema: Record<string, unknown> },
  modelId = process.env.BEDROCK_FAST_MODEL_ID
): Promise<T> {
  if (!modelId)
    throw new Error(
      "BEDROCK_FAST_MODEL_ID (or an explicit modelId) is required."
    )
  const response = await getClient().send(
    new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: user }] }],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: tool.name,
              description: tool.description,
              inputSchema: { json: tool.inputSchema as DocumentType },
            },
          },
        ],
        toolChoice: { tool: { name: tool.name } },
      },
      inferenceConfig: { maxTokens: 4096, temperature: 0 },
    })
  )
  const blocks = response.output?.message?.content ?? []
  const toolUse = blocks.find((b) => b.toolUse)?.toolUse
  if (!toolUse?.input)
    throw new Error(
      `Judge did not return a ${tool.name} tool call (stopReason=${response.stopReason}).`
    )
  return toolUse.input as T
}
