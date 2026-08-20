import { config as loadEnv } from "dotenv"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { NextConfig } from "next"

// Env vars live in the monorepo root .env (shared with the seed/verify
// scripts under packages/graph-client), not apps/web/.env — Next only
// auto-loads the latter, so load the root file explicitly.
loadEnv({ path: path.resolve(fileURLToPath(import.meta.url), "../../../.env") })

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui", "@workspace/retrieval", "@workspace/graph-client", "@workspace/graph-schema"],
  // neo4j-driver does raw Buffer manipulation for the Bolt binary protocol —
  // bundling it through Turbopack corrupts that (RangeError on session.run).
  // Keep it as a native require() instead.
  serverExternalPackages: ["neo4j-driver", "better-sqlite3"],
}

export default nextConfig
