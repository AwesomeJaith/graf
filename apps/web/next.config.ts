import { config as loadEnv } from "dotenv"
import path from "node:path"
import type { NextConfig } from "next"

// Env vars live in the monorepo root .env (shared with the seed/verify
// scripts under packages/graph-client), not apps/web/.env — Next only
// auto-loads the latter, so load the root file explicitly.
//
// Resolved from the working directory rather than `import.meta.url`: this
// package is deliberately CommonJS (no `"type": "module"` in package.json,
// unlike every package/* here) because Vercel's Node launcher `require()`s the
// compiled route handlers, and an ESM package scope makes that a hard
// ERR_REQUIRE_ESM on every single route. Next always runs with the app
// directory as cwd, locally and on Vercel alike.
loadEnv({ path: path.resolve(process.cwd(), "../../.env") })

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui", "@workspace/retrieval", "@workspace/graph-client", "@workspace/graph-schema", "@workspace/vector-index"],
  // The embedding index is read from disk at runtime through a path that only
  // exists in an env var, so nothing in the module graph points at it and file
  // tracing would leave it out of the serverless bundle — the deployment would
  // build fine and then answer every question with an empty index.
  outputFileTracingIncludes: {
    "/api/**": ["./data/**"],
  },
  // neo4j-driver does raw Buffer manipulation for the Bolt binary protocol —
  // bundling it through Turbopack corrupts that (RangeError on session.run).
  // Keep it as a native require() instead.
  serverExternalPackages: ["neo4j-driver", "better-sqlite3"],
}

export default nextConfig
