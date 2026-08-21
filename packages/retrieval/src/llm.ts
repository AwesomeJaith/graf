import { BedrockRuntimeClient, ConverseCommand, type Message } from "@aws-sdk/client-bedrock-runtime"
import type { DocumentType } from "@smithy/types"

export interface LlmConfig {
  region: string
  modelId: string
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const region = env.AWS_REGION
  const modelId = env.BEDROCK_MODEL_ID
  if (!region || !modelId) {
    throw new Error("AWS_REGION and BEDROCK_MODEL_ID must be set to use Bedrock chat inference.")
  }
  return { region, modelId }
}

let client: BedrockRuntimeClient | undefined

function getClient(region: string): BedrockRuntimeClient {
  if (!client) client = new BedrockRuntimeClient({ region })
  return client
}

/**
 * One Converse call, forced to call a single named tool, so the response is
 * always the structured JSON the pipeline stage needs (query understanding,
 * entity ranking, answer synthesis) instead of free text to parse.
 */
export async function callStructured<T = unknown>(opts: {
  system: string
  prompt: string
  toolName: string
  toolDescription: string
  inputSchema: Record<string, unknown>
  config?: LlmConfig
  /**
   * Aborts the in-flight Converse call. Worth carrying all the way down here
   * rather than only checking between stages: synthesis is the longest single
   * call in a turn, so most of the time a cancel lands, it lands inside one of
   * these — and an un-aborted call keeps burning tokens against the account's
   * rate limit long after nothing is listening for the answer.
   */
  signal?: AbortSignal
}): Promise<T> {
  const config = opts.config ?? loadLlmConfig()
  const messages: Message[] = [{ role: "user", content: [{ text: opts.prompt }] }]

  const response = await getClient(config.region).send(
    new ConverseCommand({
      modelId: config.modelId,
      system: [{ text: opts.system }],
      messages,
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: opts.toolName,
              description: opts.toolDescription,
              inputSchema: { json: opts.inputSchema as DocumentType },
            },
          },
        ],
        toolChoice: { tool: { name: opts.toolName } },
      },
    }),
    { abortSignal: opts.signal }
  )

  const content = response.output?.message?.content ?? []
  const toolUse = content.find((block) => block.toolUse)?.toolUse
  if (!toolUse?.input) {
    throw new Error(`Bedrock did not return a ${opts.toolName} tool call.`)
  }
  return toolUse.input as T
}
