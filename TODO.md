# Graf — Hack Hydra Track 1 build plan

Deadline: **today, Aug 20 2026, 11:59 PM PT**. Scope is cut hard to what's needed
for a convincing live demo + submission, not a production system.

Confirmed facts (don't re-derive):
- HydraDB: Rust, OpenCypher subset over Bolt (neo4j-driver, `neo4j://host:7687`,
  auth scheme `bearer` via `neo4j.auth.bearer(token)`) and HTTPS JSON
  (`POST /v1/graphs/default/query`, `Authorization: Bearer`, `X-Graph-Namespace`).
  Cypher subset: no `IN`/`CONTAINS`/`ENDS WITH`/`IS NULL`, no `min`/`max`, one
  rel-type per hop, variable-length paths need a bounded max, batch writes need
  `UNWIND $rows` (list-of-maps parameter, Bolt-only, not inline lists).
  Path procedures: `algo.SPpaths` / `SSpaths` / `MSpaths` for real path objects.
- Local dev node is running now: Docker container `graf-hydradb`, Bolt
  `127.0.0.1:7687`, HTTP `127.0.0.1:8443`, token in `.hydradb/auth-token`
  (`local-development-token-32-bytes`), plaintext. Verified with a live
  write/read round trip.
- AWS: CLI already authenticated (account 388724729592), Bedrock has Claude
  models enabled (`anthropic.claude-sonnet-5` etc). No Lightsail/deploy work
  this session — local demo only, per user's "don't deploy yet."
- Repo is a pnpm/turborepo monorepo: `apps/web` (Next.js 16 + shadcn/ui already
  scaffolded), `packages/ui`, `packages/eslint-config`, `packages/typescript-config`.
- `prompts/` dir is gitignored — that's where the proprietary prompt docs live.
- Design refs: `/Users/noodles/Downloads/fallback-avatar` (gradient rounded-square
  avatar fallback, SVG mask+blur), `/Users/noodles/Downloads/morph-surface`
  (spring `motion/react` morphing surface) — pattern language to reuse, not files
  to import directly.
- Theme: bg `#262626`, surface `#373737`, accent `#D74C26`, Inter font, small
  radii, bold-over-size-for-hierarchy, thin consistent spacing.

## Checklist

### 0. Setup
- [x] Read prompt.md, graph-element-reference.md, discord-update-prompt.md
- [x] Research HydraDB (query model, auth, client lib) — fork
- [x] Research EnterpriseRAG-Bench data format — fork
- [x] Stand up local HydraDB dev node in Docker, verify round trip
- [x] Read HydraDB cypher-compat subset doc
- [x] Write this TODO.md
- [x] `.env.example` + wire `.env` for local dev (HydraDB + AWS Bedrock)

### 1. Graph layer (`packages/graph-client`) — done
- [x] `neo4j-driver` (Bolt) wrapper for writes/scripts + a second HTTP/JSON
      transport (`runQueryHttp`) for reads from the Next.js server — Bolt's
      binary framing gets corrupted running inside Turbopack's dev process,
      HTTP transport doesn't have that problem
- [x] Node/Relationship/Path unwrapping to plain JS objects (both transports)
- [x] Seed script (`pnpm run seed:demo`) — Sam/Atlas scenario w/ deliberate
      name ambiguity, conflicting launch-date docs (CONTRADICTS+SUPERSEDES),
      temporal OWNS edges
- [~] Schema introspection: HydraDB has no catalog (`MATCH (n)` bare scan is
      rejected), so `packages/graph-schema`'s declared schema is the source of
      truth instead of runtime introspection — same effect (nothing hardcoded
      per-label in the pipeline), different mechanism than originally planned

### 2. Bench ingestion (`packages/bench`) — done
- [x] Real EnterpriseRAG-Bench data (not synthetic): curated 135-doc/55-question
      slice across all 9 source types, committed under `packages/bench/data/`
- [x] Ingested: 449 nodes (Person 204, Org 55, Project 24, Channel 9, Message 19,
      Document 49, Task 65, Issue 7, Decision 1) + 891 relationships, incl. 7
      real ground-truth CONTRADICTS edges from the benchmark's conflicting_info
      questions
- [x] Schema-adaptive: ingestion maps to whatever `graph-schema` declares

### 3. Retrieval pipeline (`packages/retrieval`) — done, live end to end
- [x] Bedrock Converse client w/ forced tool-use for structured output (`llm.ts`)
- [x] Query understanding + entity resolution: real candidate pool from
      HydraDB, ranked by the model using each candidate's actual one-hop graph
      neighbors (not just name similarity) — this is what makes "Sam" resolve
      to Sam Ratnaparkhi 95%+ instead of guessing from title text alone
- [x] Graph query planning + traversal via `algo.SSpaths` (one query per
      resolved entity, bounded 3 hops); conflict/supersession types always
      included regardless of what the planner asked for
- [x] Conflict/temporal reasoning: deterministic, graph-driven (SUPERSEDES
      direction or newer timestamp wins), deduped per node pair
- [x] Answer synthesis w/ claim→node-id citations, response-mode prompt variants

### 4. API (`apps/web/app/api`) — done, simplified
- [x] `POST /api/chat` — synchronous JSON (not SSE): `{question, mode,
      overrides?}` → `{answer, claims, trace, entityResolutions, conflicts,
      stages}`. Stage sequence in the UI is a client-side ticker, not live
      server events — scope cut for time, revisit if there's time later.
- [x] Entity re-resolution: `overrides` on the same endpoint (mention →
      chosen candidate id/label) instead of a separate route
- [ ] `GET /api/graph/schema` — cut, not needed for the demo (schema is
      loaded server-side already; no dynamic client-side copy depends on it)

### 5. Chat UI (`apps/web`) — core done
- [x] Theme tokens (`#262626`/`#373737`/`#D74C26`) + Inter
- [x] Full-screen layout: chat center, fixed input, minimal chrome
- [x] Avatar fallback (gradient rounded-square, hash-based)
- [x] Markdown renderer
- [x] Entity disambiguation chips (confidence %, click to re-resolve)
- [x] Graph trace panel: real subgraph from the pipeline, staggered reveal,
      click-node inspect panel, click-claim → highlight path (verified in
      browser via Playwright)
- [x] Conflict card UI
- [x] Response mode selector (concise/normal/verbose)
- [ ] CSV table renderer, Slack-style message history renderer, generic file
      preview — cut for time, not required for the core demo path

### 6. Eval (`packages/bench` eval harness) — both sides done
- [x] `bench:ingest`, `bench:baseline` (vector RAG), `bench:graph` (graph
      retrieval), `bench:eval` all run clean end to end on all 55 questions
- [x] Baseline vector RAG: 25% correctness / 37% completeness / 83% doc recall
- [x] Graph retrieval (`@workspace/retrieval`): 19% correctness / 27%
      completeness / **93%** doc recall — wins clearly on doc recall
      (96-100% on `project_related`/`conflicting_info`, the cross-source
      aggregation + conflict categories the connected ingestion was built
      for), currently behind on correctness/completeness for reasons that
      are about answer-synthesis input quality, not the traversal mechanism
      — see the honest writeup in `packages/bench/README.md` (found/fixed a
      real bug along the way: `dsid` wasn't declared in `graph-schema`'s
      property lists, so schema-driven queries silently dropped it from every
      result — fixed in both `graph-schema` and `ingest.ts`)
- [ ] If there's time left: tighten the relevance-ranking cutoff further, or
      re-rank with an LLM pass instead of pure cosine, to close the
      correctness/completeness gap without losing the recall win

### 7. Submission
- [x] README: setup, HydraDB usage explanation, how to run
- [x] LICENSE.md present (MIT), committed
- [x] No commits before Aug 12 (repo created today — satisfied)
- [x] Committed + pushed to github.com/AwesomeJaith/graf
- [x] Discord milestone update sent
- [ ] Remind user: record ≤3min demo video + submit Google form (can't do this
      part for them)
- [ ] Keep committing/pushing periodically as remaining items land
