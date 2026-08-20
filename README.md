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

## Why HydraDB, not just a vector store

The retrieval path is graph-native end to end, not vector search with a
graph skin on top:

- **Entity resolution** pulls real candidate nodes from HydraDB
  (`MATCH (n:Person) ...`) and ranks them using each candidate's actual
  graph neighbors (`algo.SSpaths`), not just name similarity — so "Sam" is
  resolved by noticing which candidate is actually `WORKS_ON` the "Atlas"
  the question also mentions.
- **Multi-hop traversal** uses HydraDB's native `algo.SSpaths` path
  procedure to walk bounded paths (Person → Project → Channel → Decision →
  Document) in one query per resolved entity, returning real relationship
  ids and properties.
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
apps/web                 Next.js chat UI + /api/chat route
packages/retrieval        The pipeline above (LLM calls via AWS Bedrock)
packages/graph-client      HydraDB client — Bolt (neo4j-driver, writes/scripts)
                           + HTTP/JSON (reads from the Next.js server)
packages/graph-schema      Schema-agnostic entity/relationship model
packages/vector-index      Embedding sidecar for entity-resolution ranking
                           and the baseline-RAG comparison in the eval harness
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

### 4. Run the app

```bash
pnpm --filter web dev
```

Open http://localhost:3000.

## Benchmark evaluation

```bash
pnpm run bench:baseline   # baseline vector-only RAG → packages/bench/data/baseline-answers.sample.jsonl
pnpm run bench:eval packages/bench/data/baseline-answers.sample.jsonl baseline-vector-rag
```

`bench:eval <answers.jsonl> <label>` scores any system's answers (in
EnterpriseRAG-Bench's own `{question_id, answer, document_ids}` format)
against the 55 sample questions and writes
`packages/bench/data/results/<label>.json`, broken down by question category
(multi-hop, temporal, conflicting-info, etc.), not just one aggregate score.
See [`packages/bench/README.md`](packages/bench/README.md) for the current
baseline numbers and how the sample question/document set was chosen.

## License

MIT — see [LICENSE.md](LICENSE.md). HydraDB itself is AGPL-3.0 licensed;
this project only depends on it as a client, it does not embed or modify
HydraDB source.
