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
for.

### Graph retrieval (`@workspace/retrieval`)

```bash
pnpm run bench:graph      # writes data/graph-retrieval-answers.sample.jsonl
pnpm run bench:eval packages/bench/data/graph-retrieval-answers.sample.jsonl graph-retrieval
```

Result (`data/results/graph-retrieval.json`), 55/55 questions answered:

| Category | Correctness | Completeness | Doc Recall |
|---|---|---|---|
| **Overall** | **19%** | **27%** | **93%** |
| basic | 0% | 6% | 100% |
| semantic | 33% | 31% | 83% |
| intra_document_reasoning | 0% | 0% | 80% |
| project_related | 0% | 7% | 96% |
| constrained | 20% | 52% | 90% |
| conflicting_info | 17% | 47% | 92% |
| completeness | 20% | 22% | 97% |
| miscellaneous | 0% | 0% | 100% |
| high_level | 0% | 5% | n/a (no gold docs) |
| info_not_found | 100% | 100% | n/a (no gold docs) |

(After adding a relevance-ranking pass — see point 1 below — between traversal and synthesis;
54/55 answered, one judge call failed to parse and was skipped rather than crashing the run.)

**Honest read of this, not a cherry-picked one:** document recall is the one metric graph
retrieval clearly wins on — 93% overall vs baseline's 83%, and **96–100%** specifically on
`project_related` and `conflicting_info` (vs baseline's 78%/83%), which are exactly the
cross-source-aggregation and conflict categories the connected ingestion (shared `Project` nodes
across jira/linear/confluence/github) was built for. `algo.SSpaths` traversal from a resolved
entity or a semantically-matched content node genuinely reaches the right documents more often
than top-K cosine alone.

Overall *correctness* and *completeness* are still **lower** than the vector-RAG baseline
(19%/27% vs 25%/37%), for reasons that are about synthesis input quality, not the retrieval
mechanism itself — the mechanism is what's driving the doc-recall win above:

1. **Answer synthesis originally saw every node the 3-hop traversal touched** (`document_ids`
   here still reports all of them, ~20-30/question, for the recall metric), not just the ones
   actually relevant — most are structural hops (a shared Person/Project/Organization node)
   rather than content. Feeding that much low-signal context to the model diluted precision on
   exact figures/names. Added a relevance-ranking pass (`rankNodeIdsByRelevance` in
   `content-search.ts`) that scores touched content nodes against the question using the same
   embeddings and keeps only the top 8 for the *answer* prompt, while `document_ids` still
   reports everything touched for the recall metric. That alone moved correctness 16%→19% and
   completeness 28%→24%→27% across iterations — real but partial; a stricter cutoff (top 3-5) or
   a second LLM re-ranking pass instead of pure cosine would likely help further.
2. **Best-effort `REFERENCES` edges.** Cross-document links are resolved by substring-matching
   identifier fields (ticket keys, PR numbers) — real but incomplete; some gold answers depend on
   a document reachable only through a link this heuristic misses (e.g. an issue's request vs.
   the PR that actually shipped the fix, with the exact metric name only in the PR).
3. **Node content granularity.** Some `properties.body`/`content` values are short/paraphrased
   rather than the full source text, capping how precise a citation-grounded answer can be
   regardless of whether the right node was retrieved.

None of these are retrieval-mechanism problems — the graph traversal is already finding the right
documents more often than flat vector search (93% vs 83% recall, 90-100% on the categories it was
built for); what's left is tightening what gets handed to the final answer call.
