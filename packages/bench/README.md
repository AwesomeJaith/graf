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

## Evaluation

`src/run-eval.ts` scores any system against the 55 sample questions, in the exact answers.jsonl
format EnterpriseRAG-Bench's own `quickstart.md` defines:

```jsonl
{"question_id": "qst_0001", "answer": "...", "document_ids": ["dsid_..."]}
```

```bash
pnpm run bench:eval <answers.jsonl> <label>
# writes data/results/<label>.json + prints an overall + per-category table
```

Metrics (simplified single-LLM-judge version of the real benchmark's 3-judge-consensus flow —
see `src/judge.ts` for what's simplified and why): **Correctness** (holistic LLM judgment vs
gold answer), **Completeness** (fraction of `answer_facts` supported), **Document Recall**
(fraction of gold `expected_doc_ids` present in the candidate's `document_ids`), **Invalid Extra
Documents** (candidate docs outside the gold set — the real benchmark runs a 3-judge relevance
classification here instead of a strict set difference).

### Baseline: vector RAG (no graph)

`src/baseline-vector-rag.ts` is the "baseline vector/standard RAG" comparison point from the
product brief — embed every document, embed the question, cosine-rank, stuff the top-5 into one
LLM call. No graph, no entity resolution, no traversal, no conflict handling.

```bash
pnpm run bench:baseline   # writes data/baseline-answers.sample.jsonl
pnpm run bench:eval packages/bench/data/baseline-answers.sample.jsonl baseline-vector-rag
```

Result (`data/results/baseline-vector-rag.json`), 55/55 questions answered:

| Category | Correctness | Completeness | Doc Recall |
|---|---|---|---|
| **Overall** | **25%** | **37%** | **83%** |
| basic | 50% | 59% | 100% |
| semantic | 17% | 17% | 83% |
| intra_document_reasoning | 20% | 27% | 80% |
| project_related | 0% | 2% | 78% |
| constrained | 40% | 67% | 90% |
| conflicting_info | 0% | 45% | 83% |
| completeness | 0% | 18% | 80% |
| miscellaneous | 20% | 20% | 60% |
| high_level | 0% | 10% | n/a (no gold docs) |
| info_not_found | 100% | 100% | n/a (no gold docs) |

This is the number graph retrieval needs to beat, category by category — note flat vector RAG
gets reasonable document recall almost everywhere (it's finding roughly the right documents) but
correctness collapses exactly on the categories that require reasoning across documents rather
than reading one: `project_related` (0%, needs multi-doc aggregation), `conflicting_info` (0%,
retrieves both conflicting docs but has no mechanism to reconcile them), `completeness` (0%,
partial retrieval instead of exhaustive), `high_level` (0%, no single/few documents contain the
answer). That gap is exactly what graph traversal + conflict resolution + entity resolution is
for — run the same `bench:eval` command against `@workspace/retrieval`'s output on these same 55
questions for the comparison.
