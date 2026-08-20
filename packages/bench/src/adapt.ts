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

function fieldToText(raw: Record<string, unknown>, field: string): string {
  const value = raw[field]
  return typeof value === "string" ? value : strList(value).join("\n")
}

/**
 * The benchmark declares which of a document's own fields actually hold body
 * text via `content_field_names` — it varies per document/source (a confluence
 * page might be `body` or `content`; a jira ticket might need `description` alone
 * or a dozen fields like `investigation`/`root_cause`/`resolution`/`comments`).
 * Reading a single hardcoded field per source type silently drops most of the
 * real content for many documents — read the declared fields instead, and only
 * fall back to a fixed field when a document doesn't declare any.
 */
function resolveContent(raw: Record<string, unknown>, fallbackFields: string[]): string {
  const declared = strList(raw.content_field_names)
  const fields = declared.length > 0 ? declared : fallbackFields
  const multi = fields.length > 1
  return fields
    .map((field) => {
      const text = fieldToText(raw, field)
      return text ? (multi ? `${titleCase(field)}:\n${text}` : text) : ""
    })
    .filter(Boolean)
    .join("\n\n")
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
      content: resolveContent(raw, ["body"]),
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
      content: resolveContent(raw, ["content"]),
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
    return {
      dsid,
      sourceType,
      label: "Document",
      primaryText: str(raw.title),
      properties: {
        title: str(raw.title),
        content: resolveContent(raw, ["summary", "next_steps", "action_items"]),
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
    return {
      dsid,
      sourceType,
      label: "Message",
      primaryText: str(raw.subject),
      properties: {
        text: resolveContent(raw, ["messages"]) || str(raw.subject),
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

  slack: ({ dsid, sourceType, raw }) => {
    const text = resolveContent(raw, ["text"])
    return {
      dsid,
      sourceType,
      label: "Message",
      primaryText: text.slice(0, 140),
      properties: {
        text,
        source: "slack",
        sent_at: str(raw.first_message_ts),
        thread_id: str(raw.thread_ts),
      },
      people: people([{ relation: "AUTHORED", values: raw.participants }]),
      channelKey: str(raw.channel) || undefined,
      knownKeys: [dsid, str(raw.thread_ts)].filter(Boolean),
      linkTexts: [],
    }
  },

  jira: ({ dsid, sourceType, raw }) => ({
    dsid,
    sourceType,
    label: "Task",
    primaryText: str(raw.summary),
    properties: {
      title: str(raw.summary),
      description: resolveContent(raw, ["description"]),
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
      description: resolveContent(raw, ["description"]),
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
      body: resolveContent(raw, ["body", "release_notes"]),
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
      content: resolveContent(raw, ["next_step", "blockers"]),
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
