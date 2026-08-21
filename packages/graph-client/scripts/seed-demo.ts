import "dotenv/config"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { VectorIndex, embedText } from "@workspace/vector-index"
import { isByogEnabled, runWritesByog } from "../src/byog"
import { closeDriver, runWrites } from "../src/client"
import {
  upsertNodesBatch,
  upsertRelationshipsBatch,
  type QuerySpec,
  type UpsertNodeRow,
  type UpsertRelationshipRow,
} from "../src/cypher"

/**
 * Hand-authored demo graph matching the prompt.md walkthrough (Sam / Atlas
 * ambiguity, multi-hop trace, conflicting launch dates, temporal ownership).
 * This is the deadline safety net: the live demo works off this graph even
 * if bench ingestion isn't finished.
 *
 * Honours `GRAF_GRAPH_TRANSPORT=byog`, so the same demo graph can be written to
 * a HydraDB Cloud collection — which is what a hosted deployment reads, since
 * it has no way to reach a HydraDB node on a laptop.
 */

/** True when writing to HydraDB Cloud rather than a local node over Bolt. */
const byog = isByogEnabled()

/**
 * The two transports disagree about one thing: the cloud's `MERGE` needs the
 * label inside the pattern, while the self-hosted node's Cypher subset only
 * accepts a bare `MERGE (n {id})` followed by `SET n:Label` (see
 * upsertNodesBatch). Everything else about these statements is identical, so
 * the choice is a flag rather than two code paths.
 */
async function writeAll(specs: QuerySpec[]): Promise<void> {
  if (byog) return runWritesByog(specs)
  return runWrites(specs)
}

const persons: UpsertNodeRow[] = [
  {
    id: 1,
    label: "Person",
    primary_text: "Sam Ratnaparkhi",
    name: "Sam Ratnaparkhi",
    title: "Engineering Lead",
    email: "sam.r@acme.example",
    source: "internal",
  },
  {
    id: 2,
    label: "Person",
    primary_text: "Samuel Chen",
    name: "Samuel Chen",
    title: "Product Manager",
    email: "samuel.chen@acme.example",
    source: "internal",
  },
  {
    id: 3,
    label: "Person",
    primary_text: "Sam Wilson",
    name: "Sam Wilson",
    title: "Sales Rep",
    email: "sam.wilson@acme.example",
    source: "internal",
  },
  {
    id: 4,
    label: "Person",
    primary_text: "Priya Nair",
    name: "Priya Nair",
    title: "Infrastructure Lead",
    email: "priya.nair@acme.example",
    source: "internal",
  },
  {
    id: 5,
    label: "Person",
    primary_text: "Sarah Kim",
    name: "Sarah Kim",
    title: "VP Engineering",
    email: "sarah.kim@acme.example",
    source: "internal",
  },
]

const organizations: UpsertNodeRow[] = [
  {
    id: 60,
    label: "Organization",
    primary_text: "Acme Corp",
    name: "Acme Corp",
    kind: "internal",
  },
]

const projects: UpsertNodeRow[] = [
  {
    id: 10,
    label: "Project",
    primary_text: "Atlas Infrastructure",
    name: "Atlas Infrastructure",
    summary: "Core platform migration project",
    status: "in_progress",
  },
  {
    id: 11,
    label: "Project",
    primary_text: "Atlas CRM",
    name: "Atlas CRM",
    summary: "Customer relationship tooling",
    status: "in_progress",
  },
]

const channels: UpsertNodeRow[] = [
  {
    id: 20,
    label: "Channel",
    primary_text: "#atlas-infra",
    name: "#atlas-infra",
    source: "slack",
  },
  {
    id: 21,
    label: "Channel",
    primary_text: "#atlas-crm",
    name: "#atlas-crm",
    source: "slack",
  },
]

const messages: UpsertNodeRow[] = [
  {
    id: 30,
    label: "Message",
    primary_text:
      "Given the infra migration isn't done, we need to push the Atlas launch to September.",
    text: "Given the infra migration isn't done, we need to push the Atlas launch to September.",
    source: "slack",
    sent_at: "2026-08-14T10:00:00Z",
    thread_id: "atlas-infra-114",
  },
  {
    id: 31,
    label: "Message",
    primary_text: "Atlas launches August 20 — plan is locked.",
    text: "Atlas launches August 20 — plan is locked.",
    source: "slack",
    sent_at: "2026-08-07T09:00:00Z",
    thread_id: "atlas-infra-090",
  },
]

const documents: UpsertNodeRow[] = [
  {
    id: 40,
    label: "Document",
    primary_text: "Atlas Migration Plan",
    title: "Atlas Migration Plan",
    content:
      "Infrastructure migration steps required before the Atlas launch can proceed safely.",
    url: "https://drive.example/atlas-migration-plan",
    source: "google_drive",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  },
  {
    id: 41,
    label: "Document",
    primary_text: "Atlas Launch Decision — Aug 15",
    title: "Atlas Launch Decision",
    content:
      "Formal decision: Atlas launch postponed to September 3 pending infrastructure migration completion.",
    url: "https://drive.example/atlas-launch-decision",
    source: "google_drive",
    created_at: "2026-08-15T00:00:00Z",
    updated_at: "2026-08-15T00:00:00Z",
  },
  {
    id: 42,
    label: "Document",
    primary_text: "Atlas Launch Plan v1 — Aug 7",
    title: "Atlas Launch Plan v1",
    content: "Original plan: Atlas launches August 20.",
    url: "https://drive.example/atlas-launch-plan-v1",
    source: "google_drive",
    created_at: "2026-08-07T00:00:00Z",
    updated_at: "2026-08-07T00:00:00Z",
  },
]

const decisions: UpsertNodeRow[] = [
  {
    id: 50,
    label: "Decision",
    primary_text:
      "Delay Atlas launch until infrastructure migration is complete",
    summary: "Delay Atlas launch until infrastructure migration is complete",
    decided_at: "2026-08-14T10:00:00Z",
    status: "active",
  },
]

async function main() {
  const nodeBatches: [string, UpsertNodeRow[]][] = [
    ["Person", persons],
    ["Organization", organizations],
    ["Project", projects],
    ["Channel", channels],
    ["Message", messages],
    ["Document", documents],
    ["Decision", decisions],
  ]

  await writeAll(
    nodeBatches.map(([label, rows]) =>
      upsertNodesBatch(label, rows, { labelInMergePattern: byog })
    )
  )
  console.log(
    `Seeded ${nodeBatches.reduce((n, [, rows]) => n + rows.length, 0)} nodes.`
  )

  const rel = (
    id: number,
    sourceId: number,
    destinationId: number,
    relType: string,
    extra: Record<string, string | number | boolean> = {}
  ): UpsertRelationshipRow => ({
    id,
    sourceId,
    destinationId,
    rel_type: relType,
    ...extra,
  })

  // HydraDB's batch UNWIND/MATCH/MERGE form requires each endpoint pattern to
  // name exactly one label, so every group below is scoped to a single
  // (relType, sourceLabel, destinationLabel) triple — a relationship type
  // that connects more than one label pair needs one group per pair.
  const relationshipBatches: [
    string,
    string,
    string,
    UpsertRelationshipRow[],
  ][] = [
    [
      "MEMBER_OF",
      "Person",
      "Organization",
      [1, 2, 3, 4, 5].map((personId, i) =>
        rel(100 + i, personId, 60, "MEMBER_OF")
      ),
    ],
    [
      "OWNS",
      "Person",
      "Project",
      [
        rel(200, 4, 10, "OWNS", {
          valid_from: "2026-01-01T00:00:00Z",
          valid_to: "2026-06-30T23:59:59Z",
        }),
        rel(201, 1, 10, "OWNS", {
          valid_from: "2026-07-01T00:00:00Z",
          valid_to: "",
        }),
      ],
    ],
    [
      "WORKS_ON",
      "Person",
      "Project",
      [
        rel(210, 1, 10, "WORKS_ON"),
        rel(211, 2, 11, "WORKS_ON"),
        rel(212, 4, 10, "WORKS_ON"),
      ],
    ],
    [
      "AUTHORED",
      "Person",
      "Message",
      [rel(220, 1, 30, "AUTHORED"), rel(221, 4, 31, "AUTHORED")],
    ],
    [
      "AUTHORED",
      "Person",
      "Document",
      [
        rel(222, 5, 40, "AUTHORED"),
        rel(223, 1, 41, "AUTHORED"),
        rel(224, 4, 42, "AUTHORED"),
      ],
    ],
    [
      "DISCUSSED_IN",
      "Message",
      "Channel",
      [rel(230, 30, 20, "DISCUSSED_IN"), rel(231, 31, 20, "DISCUSSED_IN")],
    ],
    ["DISCUSSED_IN", "Project", "Channel", [rel(232, 10, 20, "DISCUSSED_IN")]],
    ["REFERENCES", "Message", "Document", [rel(240, 30, 40, "REFERENCES")]],
    [
      "REFERENCES",
      "Decision",
      "Document",
      [rel(241, 50, 40, "REFERENCES"), rel(243, 50, 41, "REFERENCES")],
    ],
    ["REFERENCES", "Decision", "Message", [rel(242, 50, 30, "REFERENCES")]],
    ["SUPERSEDES", "Document", "Document", [rel(250, 41, 42, "SUPERSEDES")]],
    ["CONTRADICTS", "Document", "Document", [rel(260, 41, 42, "CONTRADICTS")]],
    [
      "PART_OF",
      "Document",
      "Project",
      [
        rel(270, 40, 10, "PART_OF"),
        rel(271, 41, 10, "PART_OF"),
        rel(272, 42, 10, "PART_OF"),
      ],
    ],
  ]

  await writeAll(
    relationshipBatches.map(([relType, sourceLabel, destinationLabel, rows]) =>
      upsertRelationshipsBatch(relType, sourceLabel, destinationLabel, rows)
    )
  )
  console.log(
    `Seeded ${relationshipBatches.reduce((n, [, , , rows]) => n + rows.length, 0)} relationships.`
  )

  // Only the Bolt path ever opened a driver; over BYOG this would construct one
  // just to close it, against a URL the cloud deployment doesn't even have.
  if (!byog) await closeDriver()

  // Embed into the same sidecar vector-index the bench ingestion writes to,
  // so entity resolution has one consistent index across demo + bench data.
  const vectorIndexPath =
    process.env.VECTOR_INDEX_PATH ??
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "bench",
      "data",
      "vector-index.sample.json"
    )
  const index = new VectorIndex()
  index.load(vectorIndexPath)
  for (const [label, rows] of nodeBatches) {
    for (const row of rows) {
      const text = [
        row.primary_text,
        row.content,
        row.description,
        row.summary,
        row.text,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000)
      const vector = await embedText(text || String(row.primary_text) || label)
      index.upsert([
        { id: row.id, label, primaryText: String(row.primary_text), vector },
      ])
    }
  }
  index.save(vectorIndexPath)
  console.log(
    `Merged demo-graph embeddings into ${vectorIndexPath} (${index.size()} total entries).`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
