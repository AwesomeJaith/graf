import { getNodeById, listNodesByLabel, runQueryHttp, singleSourcePaths, unwrapValue, type GraphPath } from "@workspace/graph-client"
import { findNodeLabel, type GraphSchema } from "@workspace/graph-schema"

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

async function gatherCandidatePool(mention: { text: string; likelyLabels: string[] }, schema: GraphSchema): Promise<CandidatePool> {
  const labels = mention.likelyLabels.filter((l) => findNodeLabel(schema, l))
  const seen = new Map<number, ResolvedNode>()
  for (const label of labels.length > 0 ? labels : schema.nodeLabels.map((n) => n.label)) {
    const schemaEntry = findNodeLabel(schema, label)
    const spec = listNodesByLabel(label, 50, schemaEntry)
    const rows = await runQueryHttp(spec.query, spec.params)
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

/** One-hop neighbor names/types for a candidate — the graph signal a bare name/title can't give the ranker. */
async function neighborSummary(id: number, schema: GraphSchema): Promise<string> {
  const relTypes = schema.relationships.map((r) => r.type)
  if (relTypes.length === 0) return ""
  const spec = singleSourcePaths(id, { relTypes, relDirection: "both", maxLen: 1, pathCount: 6 })
  try {
    const rows = await runQueryHttp(spec.query, spec.params)
    const names = new Set<string>()
    for (const row of rows) {
      const path = row.path as GraphPath | undefined
      for (const node of path?.nodes ?? []) {
        if (node.id !== id) names.add(`${node.primaryText} (${node.label})`)
      }
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
        p.shortlist.map(async (c) => ({ ...c, neighbors: await neighborSummary(c.id, schema) }))
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

  return nonEmptyPools.map((pool) => {
    const rankedEntry = ranked.resolutions.find((r) => r.mention === pool.mention)
    const byId = new Map(pool.candidates.map((c) => [c.id, c]))
    const override = overrides.find((o) => o.mention === pool.mention)

    const sortedRanked = (rankedEntry?.ranked ?? [])
      .filter((r) => byId.has(r.id))
      .sort((a, b) => b.confidence - a.confidence)

    const candidates = sortedRanked.map((r) => {
      const c = byId.get(r.id)!
      return { id: c.id, label: c.label, primaryText: c.primaryText, confidence: r.confidence, subtitle: firstSubtitle(c) }
    })

    const resolvedId = override?.candidateId ?? candidates[0]?.id ?? pool.candidates[0]!.id

    return { mention: pool.mention, candidates: candidates.length > 0 ? candidates : fallbackCandidates(pool.candidates), resolvedId }
  })
}

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
  const rows = await runQueryHttp(spec.query, spec.params)
  const row = rows[0]
  if (!row) return undefined
  const { id: _id, label: rowLabel, primary_text, ...rest } = row
  return { id, label: (rowLabel as string) ?? label, primaryText: (primary_text as string) ?? "", properties: unwrapValue(rest) as ResolvedNode["properties"] }
}
