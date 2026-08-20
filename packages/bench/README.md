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

Body text comes from each document's own declared `content_field_names`, not a hardcoded field per
source type. The declared field list varies per document even within a source (a confluence page
might be `body` or `content`; a jira ticket might declare `description` alone or a dozen fields like
`investigation`/`root_cause`/`resolution`/`comments`), so reading one fixed field silently dropped
most of the real content for many documents.

## Running it

```bash
pnpm run bench:ingest
```

Requires `HYDRADB_BOLT_URL`/`HYDRADB_AUTH_TOKEN` (writes the graph) and `AWS_REGION`/
`BEDROCK_EMBEDDING_MODEL_ID` (embeds every node into the vector-index sidecar at
`data/vector-index.sample.json`, gitignored — regenerate rather than commit). Safe to
re-run: node/relationship ids are deterministic given the same input files, so writes are
idempotent `MERGE`s.

The sidecar is three files: a small descriptor JSON (`count`/`dim`), a `.meta.jsonl` of
id/label/primaryText one per line, and a `.vectors.bin` of packed float32 vectors located by
offset. A plain JSON array of vectors costs ~18 bytes per float as text, which is fine for a few
hundred nodes and double-digit GB for the full corpus.

## Full corpus (511,962 documents)

The full corpus is the same repo's `generated_data/sources/` (5.0 GB, gitignored — re-fetch rather
than commit it) and loads into a **HydraDB Cloud BYOG collection**, not the local node:

```bash
pnpm run bench:ingest:full     # graph + content sidecar, ~35 min, resumable from a checkpoint
pnpm run bench:embed:full      # embeddings, hours — resumable, run it after the graph lands
pnpm run bench:verify          # counts + spot-checks against whatever collection env points at
pnpm run bench:verify:index    # round-trips the vector sidecar and checks vector/meta alignment
```

Needs `HYDRA_DB_API_KEY`, plus `GRAF_GRAPH_TRANSPORT=byog`, `HYDRADB_BYOG_DATABASE`,
`HYDRADB_BYOG_COLLECTION` and `VECTOR_INDEX_PATH` for the app to read what was written.
`BENCH_MAX_DOCS=2000` with a throwaway `HYDRADB_BYOG_COLLECTION` does a strided trial run over
every source type first.

`src/ingest-full.ts` exists alongside `src/ingest.ts` rather than replacing it — the sample path is
the regression fixture and stays on Bolt/local. Four things had to differ to make half a million
documents possible at all:

- **Streaming, not batch.** The sample path holds every normalized doc and row in memory before
  writing; at corpus scale that is tens of GB. The full path works in shards of 4,000 and keeps only
  the cross-shard indexes it truly needs (link keys, id→label, written-entity dedupe).
- **Byte-measured batching.** Both transports cap request *size*, not row count — 2 MiB for Bolt,
  **256 KiB** for Cloud. Once nodes carry document bodies, row size spans three orders of magnitude
  between a Person (a name) and a confluence page (kilobytes), so any fixed row count is either
  wastefully small or fatally large. A previous full-corpus attempt died exactly this way.
- **Deterministic ids.** Ids are `10000 + hash(kind:naturalKey)` folded into a 2^50 range (inside
  float64 safe-integer range, since HydraDB renders graph integers as JSON numbers) instead of
  coming from an in-memory counter. Shard order can therefore never reassign an id, which is what
  makes every write an idempotent `MERGE` and the whole job restartable from a checkpoint.
- **Deferred embedding.** Node text streams to a queue file; `embed-full.ts` drains it separately,
  appending to the sidecar so a checkpoint costs O(new rows) rather than rewriting a ~2 GB blob.
- **Bodies out of the graph.** Document body text is written to a local content sidecar, not stored as
  a node property — see below.

### Why body text is not in the graph

HydraDB Cloud is memory-resident with a hard `maxmemory` cap, and body text is what fills it. Storing
bodies as node properties exhausted the instance at **54% of the corpus** (~420k nodes / 1.36M
relationships), after which every write returned `OOM command not allowed`. That ceiling is the
tenant's, not the client's — the ingest process itself stayed flat at 0.46 GB throughout, and there is
no cloud usage/limits endpoint to read the cap from, so the failure only shows up as write rejections.

Bodies are also the one thing the graph never queries: no Cypher Graf issues filters, joins or matches
on a document body, it only reads it back out as evidence. So they go to `ContentStore`
(`packages/vector-index/src/content-store.ts`) — an id-keyed sidecar beside the vector index, written
streaming during ingest:

```
<base>.content.jsonl   one {id, text} record per line, in write order
<base>.content.idx     id/offset/length triples, sorted by id
```

The index is held in memory (~15 MB per million records); the data file — several GB — never is. A
lookup binary-searches the index and `readSync`s that one byte range, so the web app's resident memory
stays flat regardless of corpus size. `attachBodyText` in `packages/retrieval/src/body-text.ts` merges
the text back onto nodes once, right after traversal, before anything downstream reads properties.
Nodes that already carry inline bodies win, which is what keeps the sample corpus and the demo graph
working unchanged.

`bench:strip-bodies` removes body properties from an already-loaded cloud graph in place, so a load
that predates this split can reclaim its memory and resume from its checkpoint instead of reloading
from scratch. Nothing is lost — the next ingest pass re-derives every body into the sidecar, because
it re-normalizes all 128 shards regardless of which one it resumes *writing* at.

Cross-document `REFERENCES` resolution is also stricter at this scale, in two ways. A link token must
be **6+ characters and contain a digit**: link fields include `labels`/`tags`/`topics`/`components` —
ordinary words — and at half a million documents any short generic token matches thousands of
documents.

Shape alone isn't enough, though. The first full load produced **7,376 edges from the single key
`123456`** — a quarter of all cross-document edges came from its top 15 keys. `123456` is not an
identifier; it's the fractional half of Slack thread timestamps like `1699887766.123456`, which the
tokenizer splits on the dot. Because each key resolved to one target id, all 7,376 documents got an
edge to whichever document declared the key last: arbitrary, and worse than no edge, since a traversal
landing on that hub drags an unrelated document into the evidence set. Two caps fix it, and they are
different numbers:

- **`MAX_KEY_DECLARERS`** (3) — how many documents may *declare* a key. Beyond that it's a placeholder
  and is dropped; at 2–3 (an issue and the doc written about it, say) all of them get edges rather than
  an arbitrary winner.
- **`MAX_KEY_FANOUT`** (200) — how many documents may *cite* a key. This is the one that actually
  killed the hub: only one document had to declare `123456`. Nothing during the node phase can know
  this number, since it depends on every other document's link text, so the references pass walks the
  local links queue twice — once to measure fan-out, once to write only the keys under the cap.

### Auditing the result

`bench:audit:references` exists because edge *counts* can't distinguish a well-linked corpus from an
over-matched one — target **in-degree** can. Real references spread thin; an over-matched key builds a
hub. A whole-graph `GROUP BY` exceeds the 8s read budget at 3M relationships, so it partitions the
uniformly-hashed id space and aggregates each range on the indexed `id`.

On the current load, after `--prune` removed 11,485 edges into 10 hubs:

```
39,062 cross-document REFERENCES over 9,550 targets (mean in-degree 4.09)
  in-degree 1          4,798 targets   12.3% of edges
  in-degree 2-5        3,258 targets   23.7% of edges
  in-degree 6-20       1,213 targets   30.5% of edges
  in-degree 21-100       256 targets   24.8% of edges
  in-degree 101-1000      25 targets    8.7% of edges
  in-degree >1000          0 targets    0.0% of edges
```

`--prune` is the only way to clean a graph loaded before the cap existed, since re-running the ingest
`MERGE`s edges and can only add them. Prune *before* re-running the references pass, so legitimate
edges into those same targets get restored.

`ingest-full.ts` also prints its highest-fan-out keys, marking the suppressed ones, and `bench:verify`
prints real `REFERENCES` pairs with both endpoints' text.

### What a full-corpus question actually costs

Measured on the loaded corpus (772,136 nodes / ~3.2M relationships, 1024-dim embeddings), because
every one of these was a guess worth checking before optimizing anything:

| Stage | Time | Notes |
|---|---|---|
| `planQuery` (LLM) | 3-4s | |
| `resolveEntities` | 7-23s | sub-steps ~3s; the rest is one ranking call |
| `searchContent` | ~0.8s | brute-force cosine over the whole index |
| `expandGraph` | ~1.0s | client-side hops are **not** the bottleneck |
| `synthesizeAnswer` (LLM) | 10-12s | |
| **total** | **21-41s** | 32-61s end to end through the web route |

Two things to know before trying to make this faster:

- **It's LLM-bound, not graph-bound.** Traversal and vector search together are under 2s. The ranking
  call is output-bound (a 12 KB prompt, but 40 candidates × confidence to emit), so the levers are a
  shorter shortlist or the fast model for ranking — not query tuning.
- **A slow question can exceed the chat route's own `maxDuration = 60`.** It hasn't in local runs, but
  the margin is thin at the top of that range.

The vector sidecar is loaded resident and scanned linearly: **~3.8 GB RSS and ~950ms per unfiltered
search** at full corpus (measured 1,040 MB / 247ms at 201k entries and scaled; label-filtered search
is ~10x cheaper since it skips most of the scan). At 1024 float32 dimensions a full scan streams
~3.2 GB, so search is memory-bandwidth bound — the only real lever left is scanning fewer bytes
(quantization or an ANN index), not fewer operations. Loading takes ~1s, and the index is cached in a
module-level variable, so **a long-running server won't see embeddings written after it started** —
restart it after `bench:embed:full` finishes.

### Cloud BYOG vs the local node

Cloud's Cypher is a different subset, and one difference is structural: **procedure calls are
rejected outright**, so `algo.SSpaths`/`algo.SPpaths` are unavailable. Traversal is therefore driven
client-side over `expandNeighborhood` (one `UNWIND`ed query per hop per label) instead of asking the
engine for whole paths — see `packages/retrieval/src/traverse.ts`. Also relevant when reading rows
back: the JSON renderer injects its own `id`/`labels` onto returned nodes, overwriting Graf's `id`
*property*, so app-level ids must come from explicit `n.id AS ...` projections and never from a
whole-node return.

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
across jira/linear/confluence/github) was built for. Bounded traversal from a resolved entity or a
semantically-matched content node genuinely reaches the right documents more often than top-K cosine
alone. (These numbers were measured when traversal ran through `algo.SSpaths`; it is now the
client-side hop expansion described above, which walks the same edges under the same hop/node
budget.)

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
