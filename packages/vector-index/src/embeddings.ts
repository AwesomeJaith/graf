import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime"

export interface EmbeddingClientConfig {
  region: string
  modelId: string
}

export function loadEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env
): EmbeddingClientConfig {
  const region = env.AWS_REGION
  const modelId = env.BEDROCK_EMBEDDING_MODEL_ID
  if (!region || !modelId) {
    throw new Error(
      "AWS_REGION and BEDROCK_EMBEDDING_MODEL_ID must be set to use Bedrock embeddings."
    )
  }
  return { region, modelId }
}

let client: BedrockRuntimeClient | undefined

function getClient(region: string): BedrockRuntimeClient {
  if (!client) client = new BedrockRuntimeClient({ region })
  return client
}

/** Titan Embed v2 request/response shape. Swap this function if BEDROCK_EMBEDDING_MODEL_ID points elsewhere. */
export async function embedText(
  text: string,
  config: EmbeddingClientConfig = loadEmbeddingConfig()
): Promise<number[]> {
  const body = JSON.stringify({ inputText: text })
  const response = await getClient(config.region).send(
    new InvokeModelCommand({
      modelId: config.modelId,
      contentType: "application/json",
      accept: "application/json",
      body,
    })
  )
  const payload = JSON.parse(new TextDecoder().decode(response.body))
  const embedding = payload.embedding as number[]
  if (!Array.isArray(embedding)) {
    throw new Error(
      "Bedrock embedding response did not contain an `embedding` array."
    )
  }
  return embedding
}

export async function embedTexts(
  texts: string[],
  config: EmbeddingClientConfig = loadEmbeddingConfig()
): Promise<number[][]> {
  return Promise.all(texts.map((text) => embedText(text, config)))
}
