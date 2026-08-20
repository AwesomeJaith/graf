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
- [ ] Write this TODO.md
- [ ] `.env.example` + wire `.env` for local dev (HydraDB + AWS Bedrock)

### 1. Graph layer (`packages/graph-client`)
- [ ] `neo4j-driver` wrapper: connect, run cypher, run batched UNWIND writes,
      run `algo.*` path procedures, map driver Integer/Node/Relationship types
      to plain JS objects
- [ ] Schema introspection: query distinct labels/rel-types/properties actually
      present so the rest of the app never hardcodes entity type names
- [ ] Seed script: small hand-authored demo graph (Sam/Atlas style scenario
      from prompt.md's example) so the demo works even before/alongside bench
      ingestion — this is the deadline-safety net

### 2. Bench ingestion (`packages/bench`)
- [ ] Once research lands: map a representative sample of EnterpriseRAG-Bench
      records (Slack/Gmail/Drive/Linear/GitHub/Jira/Confluence/HubSpot/Fireflies)
      to Person/Project/Document/Message/Channel/Task/Issue/Decision/Event nodes
      + WORKS_ON/AUTHORED/MENTIONED_IN/REFERENCES/DISCUSSED_IN/etc edges
- [ ] Batch-load via UNWIND into local HydraDB
- [ ] Keep it schema-adaptive: ingestion emits whatever labels the source data
      implies, doesn't require code changes per schema

### 3. Retrieval pipeline (`packages/retrieval`)
- [ ] LLM client wrapping Bedrock Converse API (Claude), model id from env
- [ ] Query understanding: extract candidate entity mentions + question type
- [ ] Entity resolution: fuzzy/LLM-ranked match against graph node names/aliases
      → ranked candidates w/ confidence; surface ambiguity when top-2 margin is small
- [ ] Graph query planning: pick traversal (start nodes, rel types, depth) from
      schema + question type
- [ ] Traversal execution against HydraDB, collect subgraph w/ provenance
      (source, timestamp) on every node/edge touched
- [ ] Conflict/temporal reasoning: detect same-fact/different-value evidence,
      pick most-current, keep alternatives inspectable
- [ ] Answer synthesis: Bedrock call over evidence, produce claim → evidence-id map
- [ ] Response modes: concise / normal / verbose prompt variants

### 4. API (`apps/web/app/api`)
- [ ] `POST /api/chat` — SSE stream: stage events (resolving/searching/
      traversing/evaluating/answer) + final {answer, claims, trace}
- [ ] `POST /api/entities/resolve` — user's disambiguation pick
- [ ] `GET /api/graph/schema` — drives dynamic UI copy

### 5. Chat UI (`apps/web`)
- [ ] Theme tokens (colors/radii/font) + Inter
- [ ] Full-screen layout: chat center, fixed input, minimal chrome
- [ ] Avatar fallback (gradient rounded-square, hash-based) per reference pattern
- [ ] Markdown renderer (clean typography, code/tables), CSV table renderer,
      Slack-style message renderer, entity/user profile card, generic file preview
- [ ] Entity disambiguation chips (confidence %, spring expand/collapse)
- [ ] Graph trace panel: real subgraph from the pipeline, animated stage
      sequence, hover/click node inspect, click-claim → highlight path
- [ ] Conflict card UI ("Conflicting information found" + selected/why)
- [ ] Response mode selector (concise/normal/verbose)

### 6. Eval (`packages/bench` eval harness)
- [ ] Baseline vector RAG vs graph retrieval vs +entity-resolution vs
      +provenance-trace, scored on the bench sample, broken down by category
- [ ] Reproducible: one script, checked-in results

### 7. Submission
- [ ] README: setup, HydraDB usage explanation, how to run
- [ ] LICENSE.md already present (MIT) — commit it
- [ ] No commits before Aug 12 (already satisfied — repo created today)
- [ ] Remind user: record ≤3min demo video + submit Google form (can't do this
      part for them)
- [ ] Periodic commits + Discord milestone updates per discord-update-prompt.md tone
