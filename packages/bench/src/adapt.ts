import type { RawDoc } from "./loader"

export interface PersonMention {
  name: string
  relation: "AUTHORED" | "ASSIGNED_TO"
}

export type ContentLabel = "Document" | "Message" | "Task" | "Issue"

export interface NormalizedDoc {
  dsid: string
  sourceType: string
  label: ContentLabel
  primaryText: string
  properties: Record<string, string | number | boolean>
  people: PersonMention[]
  /** Raw grouping key (jira/linear project, confluence space, drive team, github repo, slack channel) — becomes a shared Project node so same-project content links up across sources. */
  projectKey?: string
  channelKey?: string
  /** Customer/company name mentioned — links to the matching hubspot Organization node when one exists. */
  companyName?: string
  /** Identifiers other docs' cross-link fields might reference (ticket key, pr number, thread id, ...). */
  knownKeys: string[]
  /** Raw cross-link field values, substring-matched against every other doc's knownKeys to resolve REFERENCES edges. */
  linkTexts: string[]
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : []
}

function titleCase(slug: string): string {
  return slug
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ")
}

/** gmail/slack sometimes use snake_case handles instead of display names. */
function personName(raw: string): string {
  return raw.includes("_") && raw === raw.toLowerCase() ? titleCase(raw) : raw
}

function people(
  entries: { relation: PersonMention["relation"]; values: unknown }[]
): PersonMention[] {
  const out: PersonMention[] = []
  for (const { relation, values } of entries) {
    const names = typeof values === "string" ? [values] : strList(values)
    for (const name of names) {
      if (name) out.push({ relation, name: personName(name) })
    }
  }
  return out
}

const ADAPTERS: Record<string, (doc: RawDoc) => NormalizedDoc | undefined> = {
  confluence: ({ dsid, sourceType, raw }) => ({
    dsid,
    sourceType,
    label: "Document",
    primaryText: str(raw.title),
    properties: {
      title: str(raw.title),
      content: str(raw.body),
      url: `confluence://${str(raw.space)}`,
      source: "confluence",
      created_at: str(raw.created_at),
      updated_at: str(raw.last_updated),
    },
    people: people([
      { relation: "AUTHORED", values: raw.author },
      { relation: "AUTHORED", values: raw.reviewers },
    ]),
    projectKey: str(raw.space) || str(raw.owner_team) || undefined,
    knownKeys: [dsid],
    linkTexts: [...strList(raw.related_pages), ...strList(raw.labels)],
  }),

  google_drive: ({ dsid, sourceType, raw }) => ({
    dsid,
    sourceType,
    label: "Document",
    primaryText: str(raw.title),
    properties: {
      title: str(raw.title),
      content: str(raw.content),
      url: str(raw.path) || str(raw.original_location),
      source: "google_drive",
      created_at: str(raw.created_at),
      updated_at: str(raw.last_modified),
    },
    people: people([
      { relation: "AUTHORED", values: raw.owner },
      { relation: "AUTHORED", values: raw.collaborators },
    ]),
    projectKey: str(raw.team) || undefined,
    knownKeys: [dsid],
    linkTexts: [...strList(raw.linked_artifacts), ...strList(raw.tags)],
  }),

  fireflies: ({ dsid, sourceType, raw }) => {
    const content = [
      str(raw.summary),
      strList(raw.next_steps).join("\n"),
      strList(raw.action_items).join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n")
    return {
      dsid,
      sourceType,
      label: "Document",
      primaryText: str(raw.title),
      properties: {
        title: str(raw.title),
        content,
        url: str(raw.meeting_id),
        source: "fireflies",
        created_at: str(raw.recorded_at),
        updated_at: str(raw.recorded_at),
      },
      people: people([
        { relation: "AUTHORED", values: raw.redwood_owner },
        { relation: "AUTHORED", values: raw.redwood_attendees },
      ]),
      companyName: str(raw.customer_company) || undefined,
      knownKeys: [dsid, str(raw.meeting_id)].filter(Boolean),
      linkTexts: [
        ...strList(raw.topics),
        ...strList(raw.competitors_mentioned),
      ],
    }
  },

  gmail: ({ dsid, sourceType, raw }) => {
    const messages = strList(raw.messages).join("\n\n---\n\n")
    return {
      dsid,
      sourceType,
      label: "Message",
      primaryText: str(raw.subject),
      properties: {
        text: messages || str(raw.subject),
        source: "gmail",
        sent_at: str(raw.first_email_at),
        thread_id: str(raw.thread_id),
      },
      people: people([
        { relation: "AUTHORED", values: raw.mailbox_owner },
        { relation: "AUTHORED", values: raw.participants_internal },
      ]),
      companyName: str(raw.related_account) || undefined,
      knownKeys: [dsid, str(raw.thread_id), str(raw.deal_id)].filter(Boolean),
      linkTexts: strList(raw.related_links),
    }
  },

  slack: ({ dsid, sourceType, raw }) => ({
    dsid,
    sourceType,
    label: "Message",
    primaryText: str(raw.text).slice(0, 140),
    properties: {
      text: str(raw.text),
      source: "slack",
      sent_at: str(raw.first_message_ts),
      thread_id: str(raw.thread_ts),
    },
    people: people([{ relation: "AUTHORED", values: raw.participants }]),
    channelKey: str(raw.channel) || undefined,
    knownKeys: [dsid, str(raw.thread_ts)].filter(Boolean),
    linkTexts: [],
  }),

  jira: ({ dsid, sourceType, raw }) => ({
    dsid,
    sourceType,
    label: "Task",
    primaryText: str(raw.summary),
    properties: {
      title: str(raw.summary),
      description: str(raw.summary),
      status: str(raw.status),
      source: "jira",
      created_at: str(raw.created_at),
    },
    people: people([
      { relation: "AUTHORED", values: raw.reporter },
      { relation: "ASSIGNED_TO", values: raw.assignee },
    ]),
    projectKey: str(raw.project) || undefined,
    companyName: str(raw.customer_company) || undefined,
    knownKeys: [dsid, str(raw.key)].filter(Boolean),
    linkTexts: [
      ...strList(raw.linked_issues),
      ...strList(raw.labels),
      ...strList(raw.components),
    ],
  }),

  linear: ({ dsid, sourceType, raw }) => ({
    dsid,
    sourceType,
    label: "Task",
    primaryText: str(raw.title),
    properties: {
      title: str(raw.title),
      description: str(raw.description),
      status: str(raw.status),
      source: "linear",
      created_at: str(raw.created_at),
    },
    people: people([
      { relation: "AUTHORED", values: raw.creator },
      { relation: "ASSIGNED_TO", values: raw.assignee },
    ]),
    projectKey: str(raw.project) || undefined,
    knownKeys: [dsid, str(raw.key)].filter(Boolean),
    linkTexts: strList(raw.labels),
  }),

  github: ({ dsid, sourceType, raw }) => ({
    dsid,
    sourceType,
    label: "Issue",
    primaryText: str(raw.title),
    properties: {
      title: str(raw.title),
      body: str(raw.body) || str(raw.release_notes),
      status: str(raw.state),
      source: "github",
      created_at: str(raw.created_at),
    },
    people: people([
      { relation: "AUTHORED", values: raw.author },
      { relation: "AUTHORED", values: raw.reviewers },
    ]),
    projectKey: str(raw.repo) || undefined,
    knownKeys: [dsid, str(raw.pr_number)].filter(Boolean),
    linkTexts: [...strList(raw.linked_linear), ...strList(raw.labels)],
  }),

  hubspot: ({ dsid, sourceType, raw }) => ({
    dsid,
    sourceType,
    label: "Document",
    primaryText: str(raw.company_name),
    properties: {
      title: str(raw.company_name),
      content: [str(raw.next_step), strList(raw.blockers).join("; ")]
        .filter(Boolean)
        .join(" — "),
      url: str(raw.company_domain),
      source: "hubspot",
      created_at: str(raw.created_at),
      updated_at: str(raw.updated_at),
    },
    people: people([
      { relation: "AUTHORED", values: raw.owner },
      { relation: "ASSIGNED_TO", values: raw.se_assigned },
    ]),
    companyName: str(raw.company_name) || undefined,
    knownKeys: [dsid, str(raw.company_id)].filter(Boolean),
    linkTexts: [
      ...strList(raw.linked_fireflies),
      ...strList(raw.linked_gmail_threads),
      ...strList(raw.linked_support_tickets),
    ],
  }),
}

export function normalizeDoc(doc: RawDoc): NormalizedDoc | undefined {
  return ADAPTERS[doc.sourceType]?.(doc)
}
