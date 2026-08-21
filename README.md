# Graf

Graf is a graph-native enterprise knowledge assistant built for **Hack Hydra
Track 1** (Enterprise Context & Ontology) on top of [HydraDB](https://github.com/hydra-db/hydradb).

Ask a question in plain language — *"What did Sam decide about the Atlas
launch?"* — and Graf resolves ambiguous references against the graph
("Sam" → 95% Sam Ratnaparkhi vs. Samuel Chen / Sam Wilson), traverses real
relationships to gather evidence, detects and resolves conflicting
information using timestamps and explicit `SUPERSEDES`/`CONTRADICTS`
edges, and answers with claim-level citations back into an interactive
graph trace. Clicking a sentence in the answer highlights the exact nodes
and edges that support it.

## Live demo

**https://graf-tau.vercel.app** — password `REDACTED` (shared password,
one field; see [Deployment](#deployment)).

Try *"What did Sam decide about the Atlas launch?"*, then click a sentence in
the answer.

The hosted deployment runs against the small hand-authored demo graph in
HydraDB Cloud, **not** the 511,962-document benchmark corpus — the corpus needs
a 3.2 GB embedding index resident in memory, which no serverless function can
hold (again, see [Deployment](#deployment)). The full-corpus numbers below come
from running the same pipeline locally against the same HydraDB Cloud account.
Answers take 20-40s: most of that is LLM latency, not retrieval.

## Why HydraDB, not just a vector store

The retrieval path is graph-native end to end, not vector search with a
graph skin on top:

- **Entity resolution** pulls real candidate nodes from HydraDB
  (`MATCH (n:Person) ...`) and ranks them using each candidate's actual
  graph neighbors, not just name similarity — so "Sam" is
  resolved by noticing which candidate is actually `WORKS_ON` the "Atlas"
  the question also mentions.
- **Multi-hop traversal** walks bounded paths (Person → Project → Channel →
  Decision → Document) from each resolved entity, returning real relationship
  ids and properties. Against a local node that's one `algo.SSpaths` call per
  entity; against HydraDB Cloud, which rejects procedure calls, the same
  bounded walk is driven client-side one `UNWIND`ed hop at a time
  (`packages/retrieval/src/traverse.ts`) — same edges, same hop/node budget.
- **Conflict/temporal reasoning** is a graph fact, not an LLM guess: a
  `CONTRADICTS` or `SUPERSEDES` edge between two evidence nodes *is* the
  conflict, and the resolution (explicit direction, or the newer timestamp)
  is deterministic and inspectable.
- **Provenance** — every node/edge in the "Knowledge Trace" panel is the
  literal subgraph the pipeline touched during retrieval, not a rendered
  mock.
- **Schema-adaptive** — `packages/graph-schema` describes the active
  label/relationship model; point `GRAF_SCHEMA_PATH` at a different JSON
  file to run Graf against a different HydraDB graph without touching code.

See [`packages/retrieval/src/index.ts`](packages/retrieval/src/index.ts) for
the full pipeline: query understanding → entity resolution → graph query
planning → HydraDB traversal → evidence collection → conflict/temporal
reasoning → answer synthesis.

## Architecture

```
apps/web                   Next.js chat UI, /api/chat, shared-password gate (proxy.ts)
packages/retrieval         The pipeline above (LLM calls via AWS Bedrock)
packages/graph-client      HydraDB client — Bolt (neo4j-driver, writes/scripts),
                           HTTP/JSON (local node reads), and Cloud BYOG over HTTPS
packages/graph-schema      Schema-agnostic entity/relationship model
packages/vector-index      Embedding sidecar for entity-resolution ranking and the
                           baseline-RAG comparison, plus the document-body content store
packages/bench             EnterpriseRAG-Bench ingestion + eval harness
packages/ui                Shared shadcn/ui component library
```

## Setup

Prerequisites: Node 20+, pnpm, Docker, an AWS account with Bedrock access to
an Anthropic Claude model (Converse API) and Titan Embed v2.

```bash
pnpm install
```

### 1. Run a local HydraDB node

```bash
mkdir -p .hydradb/store .hydradb/cache
printf '%s\n' 'local-development-token-32-bytes' > .hydradb/auth-token

docker run -d --name graf-hydradb \
  --user "$(id -u):$(id -g)" \
  -p 7687:7687 -p 8443:8443 -p 9090:9090 \
  -v "$PWD/.hydradb:/data" \
  -e CLOUD_PROVIDER=local -e LOCAL_PATH=/data/store \
  -e GRAPH_NAMESPACE=default -e GRAPH_ID=default \
  -e GRAPH_CELL_ID=cell-0 -e GRAPH_CELLS=cell-0 -e GRAPH_NODE_ID=node-0 \
  -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 \
  -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
  -e GRAPH_DATA_CACHE_DIR=/data/cache \
  -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token \
  -e GRAPH_ALLOW_PLAINTEXT=true -e RUST_MIN_STACK=33554432 \
  ghcr.io/hydra-db/hydradb:latest
```

To point Graf at a different (e.g. shared/staging) HydraDB instance instead,
just set the `HYDRADB_*` vars below to that instance's connection details.

For **HydraDB Cloud** skip Docker entirely: set `GRAF_GRAPH_TRANSPORT=byog`
plus `HYDRA_DB_API_KEY`, `HYDRADB_BYOG_DATABASE` and
`HYDRADB_BYOG_COLLECTION`. That path is pure HTTPS, which is what makes a
hosted deployment possible at all — and it's where the full benchmark corpus
lives.

### 2. Configure environment

```bash
cp .env.example .env
```

`.env.example` documents every variable; defaults already match the local
Docker node above. You'll need a working AWS credential chain
(`aws sts get-caller-identity` should succeed) with Bedrock access to the
two model ids in `.env.example`.

### 3. Load data

```bash
pnpm run bench:ingest   # EnterpriseRAG-Bench sample slice (packages/bench/data) — optional, for the eval harness
pnpm run seed:demo      # hand-authored demo graph (Sam/Atlas ambiguity, conflicting launch dates, temporal ownership)
```

Run `bench:ingest` before `seed:demo`, not after: both write to the same shared
embedding sidecar, but `bench:ingest` rebuilds that file from scratch while
`seed:demo` merges into whatever's already there — reversing the order wipes
the demo graph's embeddings out of it.

For the **full 511,962-document corpus** (HydraDB Cloud, ~35 min for the graph
plus hours of embedding, both resumable) see
[`packages/bench/README.md`](packages/bench/README.md#full-corpus-511962-documents).

### 4. Run the app

```bash
pnpm --filter web dev
```

Open http://localhost:3000. Set `SITE_PASSWORD` and `SESSION_SECRET` (both in
`.env.example`) or the login page will 500 — the gate is on locally too, so
what you develop against is what deploys.

`GET /api/health` (behind the gate) reports which graph, index and models the
running instance actually reached. Worth checking first when answers come back
empty: every one of those dependencies fails by returning *nothing* rather than
an error.

## Benchmark evaluation

```bash
pnpm run bench:graph      # Graf's own pipeline → packages/bench/data/graph-retrieval-answers.*.jsonl
pnpm run bench:baseline   # baseline vector-only RAG (no graph) → .../baseline-answers.*.jsonl
pnpm run bench:eval <answers.jsonl> <label>
```

`bench:eval` scores any system's answers (in EnterpriseRAG-Bench's own
`{question_id, answer, document_ids}` format) and writes
`packages/bench/data/results/<label>.json`, broken down by question category
rather than as one aggregate.

**Full corpus, 511,962 documents, 107 of the 500 gold questions scored** (same
questions, same judge, both systems — the baseline is vector-only RAG over the
same embedding index, so the only variable is graph vs. no graph):

| | Correctness | Completeness | Doc recall | Leaderboard score |
|---|---|---|---|---|
| **Graf (graph retrieval)** | **49.5%** | **61.4%** | **52.3%** | **47.59** |
| Vector-RAG baseline | 43.0% | 52.8% | 44.2% | 40.83 |

Leaderboard score is EnterpriseRAG-Bench's own headline metric,
`mean(binary_correct × completeness)`. The +6.8 gap has a 95% CI of ±9.2 at
n=107, so treat it as directional, not decisive. Where the graph wins is not
diffuse: `conflicting_info` 80% vs 40% correctness, `constrained` 100% vs 67%,
`intra_document_reasoning` 62% vs 25% — the categories that need more than one
document read together.

Where it loses is also specific and worth stating plainly: `semantic`
questions score 12% correctness with **12% document recall**, and the baseline
does no better. Those questions are answered by finding one paraphrased
document among half a million with no named entity to anchor on, and a single
brute-force cosine pass over a 1024-dim index doesn't find it. That's the
retrieval front-end — embedding model, chunking, query expansion — not the
traversal, which is why the leaderboard gap to the top entry (metor.com, 80.34)
closes by fixing recall rather than by changing the graph.

See [`packages/bench/README.md`](packages/bench/README.md) for the sample-slice
numbers, the per-stage cost breakdown, how the corpus was ingested, and what
the simplified single-judge scoring leaves out.

## Deployment

Deployed on Vercel from the repo root (`vercel deploy --prod`), with the
project's root directory set to `apps/web`. Four things about that are not
obvious:

- **The app package is CommonJS on purpose.** Vercel's Node launcher
  `require()`s each compiled route handler, so `"type": "module"` in
  `apps/web/package.json` makes every route a runtime `ERR_REQUIRE_ESM` — a
  deployment that builds cleanly and then 500s on every request, login
  included. `next start` locally loads the same build differently and never
  reproduces it.
- **AWS credentials arrive prefixed.** Vercel reserves the whole `AWS_*`
  namespace for the function's own execution role, so Bedrock credentials are
  set as `GRAF_AWS_*` and copied into the names the SDK expects in
  `instrumentation.ts`, which runs once per instance before any request.
- **The embedding index has to be traced in explicitly.** Its path arrives in
  an env var, so nothing in the module graph references it and file tracing
  would drop it — hence `outputFileTracingIncludes` in `next.config.ts`.
  Without it the deployment builds, starts, and answers every question with an
  empty index.
- **Chat history is ephemeral there.** It's SQLite (`better-sqlite3`), and a
  serverless filesystem is read-only outside `/tmp`, so hosted threads live per
  instance and don't outlive it. Locally they persist in `.data/graf.db`.

The whole surface sits behind a shared-password gate (`apps/web/proxy.ts` +
`SITE_PASSWORD`/`SESSION_SECRET`): a jose-signed HttpOnly cookie, one form
field, every page and API route gated except the login endpoint. That's about
cost rather than secrecy — an open `/api/chat` is an open door to an AWS
Bedrock account and to a HydraDB collection holding a full enterprise corpus.

### Why the hosted demo is demo-scale

The full corpus can't run on Vercel, and the numbers are the reason rather
than a policy: the vector index is 772,114 × 1024 float32 = **3.16 GB** of
vectors, plus 103 MB of metadata and a 2.5 GB body-text sidecar, against a
250 MB unzipped function limit. Trimming to entities only (Person +
Organization + Project + Channel, 260,168 vectors) still lands at ~1.04 GB,
and brute-force cosine needs the whole thing resident anyway. A corpus that
size needs a long-lived host, not a function — so the hosted deployment reads
a 16-node HydraDB Cloud collection and a committed 67 KB index
(`apps/web/data/vector-index.demo.*`), which is enough to exercise every part
of the pipeline: ambiguity, multi-hop, conflict, citations.

## License

MIT — see [LICENSE.md](LICENSE.md). HydraDB itself is AGPL-3.0 licensed;
this project only depends on it as a client, it does not embed or modify
HydraDB source.
