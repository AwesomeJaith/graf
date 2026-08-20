import { readFileSync } from "node:fs"
import { z } from "zod"

/**
 * Graf adapts to whatever HydraDB graph/schema it is pointed at. This module
 * defines the schema shape and ships a default schema modeling
 * EnterpriseRAG-Bench-style enterprise data. Point GRAF_SCHEMA_PATH at a JSON
 * file matching GraphSchemaInput to swap schemas without touching code.
 */

export const PropertyTypeSchema = z.enum(["string", "number", "boolean"])
export type PropertyType = z.infer<typeof PropertyTypeSchema>

export const PropertyHintSchema = z.object({
  name: z.string(),
  type: PropertyTypeSchema,
  description: z.string().optional(),
})
export type PropertyHint = z.infer<typeof PropertyHintSchema>

export const NodeLabelSchemaSchema = z.object({
  label: z.string(),
  description: z.string(),
  properties: z.array(PropertyHintSchema),
  /** Property to show as the human-readable name for this entity. */
  displayNameProperty: z.string().optional(),
  /** Properties concatenated (in order) to build the text embedded for semantic search. */
  embeddingText: z.array(z.string()).optional(),
})
export type NodeLabelSchema = z.infer<typeof NodeLabelSchemaSchema>

export const RelationshipSchemaSchema = z.object({
  type: z.string(),
  description: z.string(),
  /** Allowed source labels for this relationship. "*" means any label. */
  from: z.array(z.string()),
  /** Allowed destination labels for this relationship. "*" means any label. */
  to: z.array(z.string()),
  properties: z.array(PropertyHintSchema).optional(),
})
export type RelationshipSchema = z.infer<typeof RelationshipSchemaSchema>

export const GraphSchemaSchema = z.object({
  name: z.string(),
  description: z.string(),
  nodeLabels: z.array(NodeLabelSchemaSchema),
  relationships: z.array(RelationshipSchemaSchema),
})
export type GraphSchema = z.infer<typeof GraphSchemaSchema>

/**
 * Default schema: the entity/relationship model from the product brief,
 * shaped for EnterpriseRAG-Bench sources (Slack, Gmail, Drive, Linear,
 * GitHub, Jira, Confluence, HubSpot, Fireflies).
 */
export const DEFAULT_GRAPH_SCHEMA: GraphSchema = {
  name: "enterprise-rag-bench-default",
  description:
    "Default enterprise knowledge graph schema covering people, work, communication, and documents across common workplace tools.",
  nodeLabels: [
    {
      label: "Person",
      description:
        "An individual referenced anywhere in the organization's data.",
      properties: [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
        {
          name: "email",
          type: "string",
          description: "Primary email address, if known.",
        },
        { name: "title", type: "string", description: "Job title or role." },
        {
          name: "source",
          type: "string",
          description: "System this person record originated from.",
        },
      ],
      displayNameProperty: "name",
      embeddingText: ["name", "title", "email"],
    },
    {
      label: "Organization",
      description:
        "A company or team-level grouping (internal team, customer, vendor).",
      properties: [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
        {
          name: "kind",
          type: "string",
          description: "e.g. internal, customer, vendor.",
        },
      ],
      displayNameProperty: "name",
      embeddingText: ["name"],
    },
    {
      label: "Project",
      description:
        "A named initiative or workstream (may span multiple tools).",
      properties: [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
        { name: "summary", type: "string" },
        { name: "status", type: "string" },
      ],
      displayNameProperty: "name",
      embeddingText: ["name", "summary"],
    },
    {
      label: "Document",
      description:
        "A file or written artifact (Drive doc, Confluence page, spec, etc).",
      properties: [
        { name: "id", type: "number" },
        { name: "title", type: "string" },
        { name: "content", type: "string" },
        { name: "url", type: "string" },
        { name: "source", type: "string" },
        {
          name: "created_at",
          type: "string",
          description: "ISO 8601 timestamp.",
        },
        {
          name: "updated_at",
          type: "string",
          description: "ISO 8601 timestamp.",
        },
      ],
      displayNameProperty: "title",
      embeddingText: ["title", "content"],
    },
    {
      label: "Message",
      description:
        "A single communication event (Slack message, email, Fireflies transcript line).",
      properties: [
        { name: "id", type: "number" },
        { name: "text", type: "string" },
        {
          name: "source",
          type: "string",
          description: "e.g. slack, gmail, fireflies.",
        },
        { name: "sent_at", type: "string", description: "ISO 8601 timestamp." },
        { name: "thread_id", type: "string" },
      ],
      displayNameProperty: "text",
      embeddingText: ["text"],
    },
    {
      label: "Channel",
      description:
        "A container for messages (Slack channel, email thread, meeting).",
      properties: [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
        { name: "source", type: "string" },
      ],
      displayNameProperty: "name",
      embeddingText: ["name"],
    },
    {
      label: "Task",
      description: "A unit of work (Linear issue, Jira ticket, action item).",
      properties: [
        { name: "id", type: "number" },
        { name: "title", type: "string" },
        { name: "description", type: "string" },
        { name: "status", type: "string" },
        { name: "source", type: "string" },
        { name: "created_at", type: "string" },
      ],
      displayNameProperty: "title",
      embeddingText: ["title", "description"],
    },
    {
      label: "Repository",
      description: "A GitHub (or similar) code repository.",
      properties: [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
        { name: "url", type: "string" },
      ],
      displayNameProperty: "name",
      embeddingText: ["name"],
    },
    {
      label: "Issue",
      description: "A GitHub/Jira issue or bug report.",
      properties: [
        { name: "id", type: "number" },
        { name: "title", type: "string" },
        { name: "body", type: "string" },
        { name: "status", type: "string" },
        { name: "source", type: "string" },
        { name: "created_at", type: "string" },
      ],
      displayNameProperty: "title",
      embeddingText: ["title", "body"],
    },
    {
      label: "Decision",
      description:
        "A recorded decision extracted from documents/messages, with a point in time.",
      properties: [
        { name: "id", type: "number" },
        { name: "summary", type: "string" },
        {
          name: "decided_at",
          type: "string",
          description: "ISO 8601 timestamp.",
        },
        {
          name: "status",
          type: "string",
          description: "e.g. active, superseded.",
        },
      ],
      displayNameProperty: "summary",
      embeddingText: ["summary"],
    },
    {
      label: "Event",
      description: "A calendar event or meeting.",
      properties: [
        { name: "id", type: "number" },
        { name: "title", type: "string" },
        { name: "starts_at", type: "string" },
        { name: "ends_at", type: "string" },
      ],
      displayNameProperty: "title",
      embeddingText: ["title"],
    },
  ],
  relationships: [
    {
      type: "WORKS_ON",
      description: "Person works on a Project or Task.",
      from: ["Person"],
      to: ["Project", "Task"],
    },
    {
      type: "MEMBER_OF",
      description: "Person is a member of an Organization or Channel.",
      from: ["Person"],
      to: ["Organization", "Channel"],
    },
    {
      type: "AUTHORED",
      description: "Person authored a Document, Message, Issue, or Task.",
      from: ["Person"],
      to: ["Document", "Message", "Issue", "Task"],
    },
    {
      type: "MENTIONED_IN",
      description: "An entity is mentioned inside a Document or Message.",
      from: ["Person", "Project", "Document", "Task", "Issue"],
      to: ["Document", "Message"],
    },
    {
      type: "REFERENCES",
      description: "A Decision or Document references supporting material.",
      from: ["Decision", "Document"],
      to: ["Document", "Message", "Issue", "Task"],
    },
    {
      type: "PART_OF",
      description: "An entity belongs to a broader Project or Repository.",
      from: ["Task", "Issue", "Document", "Message"],
      to: ["Project", "Repository"],
    },
    {
      type: "OWNS",
      description:
        "Person or Organization owns a Project, Repository, or Document.",
      from: ["Person", "Organization"],
      to: ["Project", "Repository", "Document"],
    },
    {
      type: "ASSIGNED_TO",
      description: "A Task or Issue is assigned to a Person.",
      from: ["Task", "Issue"],
      to: ["Person"],
    },
    {
      type: "DISCUSSED_IN",
      description:
        "A Project, Task, or Decision was discussed in a Channel or Message.",
      from: ["Project", "Task", "Decision"],
      to: ["Channel", "Message"],
    },
    {
      type: "RELATED_TO",
      description: "A generic, weaker relationship between two entities.",
      from: ["*"],
      to: ["*"],
    },
    {
      type: "DEPENDS_ON",
      description: "A Task or Issue depends on another Task or Issue.",
      from: ["Task", "Issue"],
      to: ["Task", "Issue"],
    },
    {
      type: "CONTRADICTS",
      description:
        "One Decision or Document contradicts another (conflicting facts).",
      from: ["Decision", "Document", "Message"],
      to: ["Decision", "Document", "Message"],
    },
    {
      type: "SUPERSEDES",
      description: "A newer Decision or Document supersedes an older one.",
      from: ["Decision", "Document"],
      to: ["Decision", "Document"],
    },
  ],
}

export function findNodeLabel(
  schema: GraphSchema,
  label: string
): NodeLabelSchema | undefined {
  return schema.nodeLabels.find((entry) => entry.label === label)
}

export function findRelationship(
  schema: GraphSchema,
  type: string
): RelationshipSchema | undefined {
  return schema.relationships.find((entry) => entry.type === type)
}

/**
 * Loads the active GraphSchema. Reads GRAF_SCHEMA_PATH (a JSON file matching
 * GraphSchema) when set, otherwise falls back to DEFAULT_GRAPH_SCHEMA. This
 * is the single switch for pointing Graf at a different HydraDB schema.
 */
export function loadGraphSchema(
  env: NodeJS.ProcessEnv = process.env
): GraphSchema {
  const path = env.GRAF_SCHEMA_PATH
  if (!path) return DEFAULT_GRAPH_SCHEMA
  const raw = readFileSync(path, "utf-8")
  return GraphSchemaSchema.parse(JSON.parse(raw))
}
