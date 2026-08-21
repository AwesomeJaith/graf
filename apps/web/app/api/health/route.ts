import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { activeGraphTransport, runGraphQuery } from "@workspace/graph-client"
import { loadGraphSchema } from "@workspace/graph-schema"
import { VectorIndex } from "@workspace/vector-index"

/**
 * What a deployment can actually reach, in one request.
 *
 * Graf's answers depend on three things outside the process — the graph, the
 * Bedrock models, and an embedding index read from disk — and each of them
 * fails by producing a *plausible* empty answer rather than an error: an
 * unreadable index means every question finds no evidence, a wrong collection
 * means the traversal returns nothing. On a serverless deployment, where the
 * index path is an env var and the filesystem layout isn't the repo's, that's
 * the difference between "the demo is broken" and half an hour of guessing.
 *
 * Behind the password gate like everything else (see proxy.ts), so this doesn't
 * hand an anonymous caller a map of the deployment.
 */
export async function GET() {
  const indexPath = process.env.VECTOR_INDEX_PATH ?? "(default: packages/bench/data/vector-index.sample.json)"
  const resolvedIndexPath = process.env.VECTOR_INDEX_PATH ? resolve(process.env.VECTOR_INDEX_PATH) : undefined

  let indexEntries: number | undefined
  let indexError: string | undefined
  try {
    const index = new VectorIndex()
    index.load(process.env.VECTOR_INDEX_PATH ?? "")
    indexEntries = index.size()
  } catch (err) {
    indexError = (err as Error).message
  }

  let graphNodes: number | undefined
  let graphError: string | undefined
  try {
    const rows = await runGraphQuery("MATCH (n:Person) RETURN count(n) AS c", {})
    graphNodes = Number(rows[0]?.c ?? 0)
  } catch (err) {
    graphError = (err as Error).message
  }

  return Response.json({
    graph: {
      transport: activeGraphTransport(),
      collection: process.env.HYDRADB_BYOG_COLLECTION ?? null,
      personNodes: graphNodes,
      error: graphError,
    },
    index: {
      path: indexPath,
      resolvedPath: resolvedIndexPath,
      exists: resolvedIndexPath ? existsSync(resolvedIndexPath) : undefined,
      entries: indexEntries,
      error: indexError,
    },
    // Model *ids*, not credentials: which model answered is the first thing to
    // check when quality changes between two deployments.
    models: {
      chat: process.env.BEDROCK_MODEL_ID ?? null,
      fast: process.env.BEDROCK_FAST_MODEL_ID ?? null,
      embedding: process.env.BEDROCK_EMBEDDING_MODEL_ID ?? null,
      region: process.env.AWS_REGION ?? null,
      hasCredentials: Boolean(process.env.AWS_ACCESS_KEY_ID),
    },
    schemaLabels: loadGraphSchema().nodeLabels.length,
    cwd: process.cwd(),
  })
}
