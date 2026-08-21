import { expandNeighborhood, getNodeById, listNodesByLabel, runGraphQuery, unwrapValue } from "@workspace/graph-client"
import { findNodeLabel, type GraphSchema } from "@workspace/graph-schema"

import { searchCandidatesByLabel } from "./content-search"
import { describeSchema } from "./schema-context"
import { callStructured } from "./llm"
import type { EntityResolution, ResolvedNode } from "./types"

export interface EntityOverride {
  mention: string
  candidateId: number
  label: string
}

export interface QueryPlan {
  mentions: { text: string; likelyLabels: string[] }[]
  questionType: string
  focusRelationshipTypes: string[]
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    mentions: {
      type: "array",
      description: "Every reference to a person, project, document, or other graph entity in the question.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The mention exactly as it appears in the question." },
          likelyLabels: {
            type: "array",
            items: { type: "string" },
            description: "Node labels from the schema this mention could refer to, most likely first.",
          },
        },
        required: ["text", "likelyLabels"],
      },
    },
    questionType: {
      type: "string",
      enum: ["factual", "temporal", "multi_hop", "comparison", "ownership", "other"],
    },
    focusRelationshipTypes: {
      type: "array",
      items: { type: "string" },
      description: "Relationship types from the schema most likely to lead from the mentions to an answer.",
    },
  },
  required: ["mentions", "questionType", "focusRelationshipTypes"],
}

interface CandidatePool {
  mention: string
  candidates: ResolvedNode[]
}

interface RankOutput {
  resolutions: {
    mention: string
    ranked: { id: number; confidence: number }[]
  }[]
}

const RANK_SCHEMA = {
  type: "object",
  properties: {
    resolutions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          mention: { type: "string" },
          ranked: {
            type: "array",
            description: "Candidates ranked most-likely first with a 0-1 confidence each, confidences need not sum to 1.",
            items: {
              type: "object",
              properties: { id: { type: "number" }, confidence: { type: "number" } },
              required: ["id", "confidence"],
            },
          },
        },
        required: ["mention", "ranked"],
      },
    },
  },
  required: ["resolutions"],
}

export async function planQuery(question: string, schema: GraphSchema): Promise<QueryPlan> {
  return callStructured<QueryPlan>({
    system:
      "You extract entity references and traversal hints from a question about an enterprise knowledge graph. Only use labels and relationship types that exist in the provided schema.",
    prompt: `${describeSchema(schema)}\n\nQuestion: ${question}`,
    toolName: "plan_query",
    toolDescription: "Extract entity mentions, question type, and likely traversal relationship types.",
    inputSchema: PLAN_SCHEMA,
  })
}

/**
 * An unfiltered `LIMIT 50` scan of a label is fine when that label has a few
 * dozen rows total (every real candidate is in it) but useless once a label
 * has tens/hundreds of thousands (the real match is very unlikely to land in
 * an arbitrary unordered 50-row slice) — so semantic search against the
 * mention text runs first and does the real work at any corpus size; the
 * label scan stays only as a supplement for small/cold-index cases.
 */
async function gatherCandidatePool(mention: { text: string; likelyLabels: string[] }, schema: GraphSchema): Promise<CandidatePool> {
  const labels = mention.likelyLabels.filter((l) => findNodeLabel(schema, l))
  const searchLabels = labels.length > 0 ? labels : schema.nodeLabels.map((n) => n.label)
  const seen = new Map<number, ResolvedNode>()

  const semantic = await searchCandidatesByLabel(mention.text, searchLabels, schema, 20)
  for (const node of semantic) {
    if (!seen.has(node.id)) seen.set(node.id, node)
  }

  // One round trip per label, issued together rather than awaited in series.
  // A mention the planner couldn't type falls back to *every* schema label, so
  // in series this was ~10 sequential cloud round trips per mention and the
  // single largest cost in the whole pipeline (58% of a 36s question — more
  // than synthesis and traversal combined). Ordering doesn't matter: results
  // land in an id-keyed map that already ignores duplicates.
  const scans = await Promise.all(
    searchLabels.map(async (label) => {
      const schemaEntry = findNodeLabel(schema, label)
      const spec = listNodesByLabel(label, 50, schemaEntry)
      try {
        return { label, rows: await runGraphQuery(spec.query, spec.params) }
      } catch {
        return { label, rows: [] }
      }
    })
  )

  for (const { label, rows } of scans) {
    for (const row of rows) {
      const id = row.id as number
      if (seen.has(id)) continue
      const { id: _id, label: rowLabel, primary_text, ...rest } = row
      seen.set(id, {
        id,
        label: (rowLabel as string) ?? label,
        primaryText: (primary_text as string) ?? "",
        properties: rest as ResolvedNode["properties"],
      })
    }
  }
  return { mention: mention.text, candidates: Array.from(seen.values()) }
}

function tokenOverlap(mention: string, text: string): boolean {
  const mTokens = mention.toLowerCase().split(/\s+/).filter(Boolean)
  const tTokens = text.toLowerCase().split(/\s+/).filter(Boolean)
  return mTokens.some((mt) => tTokens.some((tt) => tt.startsWith(mt) || mt.startsWith(tt)))
}

/**
 * Shrinks a (possibly noisy, up-to-50-row) candidate pool to the handful
 * worth sending to the ranking model: name/token overlap with the mention
 * first, falling back to the first few rows so a pool never goes empty.
 */
function shortlist(mention: string, candidates: ResolvedNode[], max = 8): ResolvedNode[] {
  const overlap = candidates.filter((c) => tokenOverlap(mention, c.primaryText))
  return (overlap.length > 0 ? overlap : candidates).slice(0, max)
}

/**
 * One-hop neighbor names/types for a candidate — the graph signal a bare
 * name/title can't give the ranker. This is what makes "Sam" resolve by
 * noticing which Sam actually connects to the "Atlas" the question also names,
 * so it runs per shortlisted candidate on every question.
 */
async function neighborSummary(id: number, label: string, schema: GraphSchema): Promise<string> {
  const relTypes = schema.relationships.map((r) => r.type)
  if (relTypes.length === 0 || !label) return ""
  const spec = expandNeighborhood(label, [id], relTypes, 12)
  try {
    const rows = await runGraphQuery(spec.query, spec.params)
    const names = new Set<string>()
    for (const row of rows) {
      if (row.nodeId === id) continue
      names.add(`${row.nodePrimaryText as string} (${row.nodeLabel as string})`)
    }
    return Array.from(names).slice(0, 6).join(", ")
  } catch {
    return ""
  }
}

/**
 * Resolves every mention against a real candidate pool pulled from HydraDB,
 * then asks the model to rank confidence — this is the "I found: Sam →
 * Sam Ratnaparkhi 94% / Samuel Chen 4% / Sam Wilson 2%" step made real.
 */
export async function resolveEntities(
  question: string,
  plan: QueryPlan,
  schema: GraphSchema,
  overrides: EntityOverride[] = []
): Promise<EntityResolution[]> {
  if (plan.mentions.length === 0) return []

  const pools = await Promise.all(plan.mentions.map((m) => gatherCandidatePool(m, schema)))
  const nonEmptyPools = pools.filter((p) => p.candidates.length > 0)
  if (nonEmptyPools.length === 0) return []

  const shortlisted = nonEmptyPools.map((p) => ({ ...p, shortlist: shortlist(p.mention, p.candidates) }))
  const withNeighbors = await Promise.all(
    shortlisted.map(async (p) => ({
      mention: p.mention,
      candidates: await Promise.all(
        p.shortlist.map(async (c) => ({ ...c, neighbors: await neighborSummary(c.id, c.label, schema) }))
      ),
    }))
  )

  const rankPrompt = withNeighbors
    .map(
      (p) =>
        `Mention: "${p.mention}"\nCandidates:\n${p.candidates
          .map(
            (c) =>
              `  id=${c.id} label=${c.label} text="${c.primaryText}" properties=${JSON.stringify(c.properties)}${
                c.neighbors ? ` connectsTo=[${c.neighbors}]` : ""
              }`
          )
          .join("\n")}`
    )
    .join("\n\n")

  const ranked = await callStructured<RankOutput>({
    system:
      "You resolve ambiguous entity mentions in a question to specific graph node ids, using the question's context to disambiguate. Mentions in the same question are often directly connected in the graph (e.g. a Person who WORKS_ON the Project also named in the question) — weigh a candidate's `connectsTo` graph neighbors against the other mentions' candidates, not just name/title similarity.",
    prompt: `Question: ${question}\n\n${rankPrompt}`,
    toolName: "rank_candidates",
    toolDescription: "Rank each mention's candidates by confidence that they're the entity the question refers to.",
    inputSchema: RANK_SCHEMA,
  })

  // `resolutions` is required and typed as an array by RANK_SCHEMA, but a
  // structured response is still model output — a violating shape (the key
  // missing, or an object keyed by mention) reached `.find` and took the whole
  // request down with a 500. Degrading to "nothing ranked" instead leaves every
  // mention on its vector-search order, which is the input this stage re-ranks,
  // so the answer is weaker rather than absent. Seen for real when swapping the
  // chat model: how strictly a tool schema is honoured varies between them.
  const rankedResolutions = Array.isArray(ranked?.resolutions) ? ranked.resolutions : []

  return nonEmptyPools.map((pool) => {
    const rankedEntry = rankedResolutions.find((r) => r.mention === pool.mention)
    const byId = new Map(pool.candidates.map((c) => [c.id, c]))
    const override = overrides.find((o) => o.mention === pool.mention)

    const sortedRanked = (rankedEntry?.ranked ?? [])
      .filter((r) => byId.has(r.id))
      .sort((a, b) => b.confidence - a.confidence)

    const allCandidates = sortedRanked.map((r) => {
      const c = byId.get(r.id)!
      return { id: c.id, label: c.label, primaryText: c.primaryText, confidence: r.confidence, subtitle: firstSubtitle(c) }
    })
    // Keep the top pick regardless, plus only the alternatives that are
    // actually plausible — otherwise a mention with one real match and three
    // near-zero also-rans renders as a wall of dead-weight chips.
    const candidates = allCandidates.filter((c, i) => i === 0 || c.confidence >= MIN_CANDIDATE_CONFIDENCE).slice(0, 5)

    const resolvedId = override?.candidateId ?? candidates[0]?.id ?? pool.candidates[0]!.id

    return { mention: pool.mention, candidates: candidates.length > 0 ? candidates : fallbackCandidates(pool.candidates), resolvedId }
  }).filter((resolution) => (resolution.candidates[0]?.confidence ?? 0) >= MIN_TOP_CONFIDENCE)
  // A mention the model couldn't actually connect to anything (e.g. a vague
  // phrase from the question that isn't really an entity reference) still
  // gets a ranked-but-near-zero candidate rather than an empty list — drop
  // those rather than showing a "resolved" chip that's really a non-match.
}

const MIN_TOP_CONFIDENCE = 0.08
const MIN_CANDIDATE_CONFIDENCE = 0.02

function fallbackCandidates(nodes: ResolvedNode[]) {
  return nodes.slice(0, 5).map((n, i) => ({ id: n.id, label: n.label, primaryText: n.primaryText, confidence: i === 0 ? 1 : 0, subtitle: firstSubtitle(n) }))
}

function firstSubtitle(node: ResolvedNode): string | undefined {
  const value = node.properties.title ?? node.properties.name ?? node.properties.summary
  return typeof value === "string" ? value : undefined
}

export async function fetchResolvedNode(label: string, id: number, schema: GraphSchema): Promise<ResolvedNode | undefined> {
  const schemaEntry = findNodeLabel(schema, label)
  const spec = getNodeById(label, id, schemaEntry)
  const rows = await runGraphQuery(spec.query, spec.params)
  const row = rows[0]
  if (!row) return undefined
  const { id: _id, label: rowLabel, primary_text, ...rest } = row
  return { id, label: (rowLabel as string) ?? label, primaryText: (primary_text as string) ?? "", properties: unwrapValue(rest) as ResolvedNode["properties"] }
}
