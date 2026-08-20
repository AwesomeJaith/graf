# @workspace/bench

Ingests a curated slice of [EnterpriseRAG-Bench](https://github.com/onyx-dot-app/EnterpriseRAG-Bench)
into HydraDB and builds the semantic sidecar index used for entity resolution, so Graf can be
demoed and evaluated against real benchmark questions rather than only the hand-authored
`seed-demo.ts` scenario.

## Data provenance

EnterpriseRAG-Bench ships its full ~512k-document corpus and 500 gold questions directly in its
git repo (`generated_data/sources/`, `questions.jsonl`), not just a generator. Ingesting the full
corpus is out of scope for a hackathon demo, so `data/enterprise-rag-bench-sample/` is a curated,
**connected** slice:

1. Sample questions evenly across the 8 categories that have gold documents (`basic`, `semantic`,
   `intra_document_reasoning`, `project_related`, `constrained`, `conflicting_info`,
   `completeness`, `miscellaneous`), plus a few `high_level`/`info_not_found` questions (no gold
   docs — used to demo abstention).
2. Resolve every sampled question's `expected_doc_ids` to source documents.
3. Expand one hop via each document's `project` field, pulling in a few sibling documents per
   project — without this, the subset is a disconnected forest of one-doc-per-question leaves,
   which defeats the point of demoing graph traversal. With it, ingestion produces real
   multi-hop structure (shared Project/Person/Organization nodes connecting otherwise-unrelated
   documents).

Result: 55 questions, 135 documents, all 9 source types represented, ~1.3MB — small enough to
commit directly (see `UPSTREAM_LICENSE.txt`, MIT). Regenerate a different slice by adjusting the
category quotas in the selection step (see git history / ask if you need the selection script —
it isn't part of the shipped pipeline since the sample is committed and static).

## Ingestion mapping

Each source type has a distinct JSON schema (see `src/adapt.ts` for the field mapping per type).
Common shape after normalization:

- **Content node** — one of `Document` (confluence, google_drive, fireflies, hubspot),
  `Message` (gmail, slack), `Task` (jira, linear), `Issue` (github) — see `@workspace/graph-schema`.
- **Person** nodes from author/owner/assignee/reviewer/participant fields, deduped by name,
  linked `MEMBER_OF` a single "Redwood Inference" Organization (the fictional company the
  dataset is about).
- **Project** nodes from each source's own grouping key (jira/linear `project`, confluence
  `space`, google_drive `team`, github `repo`) — the same project name mentioned across sources
  resolves to the same node, which is exactly the kind of cross-source connective tissue a flat
  vector RAG system can't represent.
- **Organization** nodes for hubspot companies, linked via `REFERENCES` from any doc that
  mentions that company (`customer_company`/`related_account` fields).
- **REFERENCES** edges resolved by substring-matching each doc's cross-link fields (ticket keys,
  PR numbers, thread ids, ...) against every other ingested doc's own identifiers — best-effort,
  since most cross-links point outside this curated subset.
- **CONTRADICTS** edges added directly from `conflicting_info` questions: that question type is
  generated from a near-duplicate document pair by construction (see EnterpriseRAG-Bench's
  `methodology.md`), so the benchmark itself tells us which two ingested docs conflict — this is
  ground truth, not inference.

Ids `10000+` are reserved for bench data so it coexists with `seed-demo.ts`'s hand-authored graph
(ids `1-999ish`) in the same HydraDB namespace without collisions.

## Running it

```bash
pnpm run bench:ingest
```

Requires `HYDRADB_BOLT_URL`/`HYDRADB_AUTH_TOKEN` (writes the graph) and `AWS_REGION`/
`BEDROCK_EMBEDDING_MODEL_ID` (embeds every node into the vector-index sidecar at
`data/vector-index.sample.json`, ~9MB, gitignored — regenerate rather than commit). Safe to
re-run: node/relationship ids are deterministic given the same input files, so writes are
idempotent `MERGE`s.
