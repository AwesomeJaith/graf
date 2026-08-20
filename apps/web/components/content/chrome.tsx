// Small shared pieces for the content renderers. Kept in their own file so
// slack-thread/email-thread/document-view can use them without importing the
// dispatcher that imports them.

import { cn } from "@workspace/ui/lib/utils"

export type NodeProperties = Record<string, string | number | boolean>

/** Display names for the benchmark's `source` values (`google_drive` → "Google Drive"). */
const SOURCE_LABELS: Record<string, string> = {
  slack: "Slack",
  gmail: "Gmail",
  confluence: "Confluence",
  google_drive: "Google Drive",
  fireflies: "Fireflies",
  jira: "Jira",
  linear: "Linear",
  github: "GitHub",
  hubspot: "HubSpot",
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, " ")
}

export function prop(properties: NodeProperties | undefined, key: string): string {
  const value = properties?.[key]
  return value === undefined || value === "" ? "" : String(value)
}

/**
 * Formats an ISO timestamp for display, pinned to UTC.
 *
 * Deliberately not localised to the viewer's zone: these components render
 * inside the graph inspector where a timestamp is evidence being checked
 * against a claim, so it needs to match what the node actually stores. Fixing
 * the zone also keeps server and client markup identical.
 */
export function formatTimestamp(raw: string): string {
  if (!raw) return ""
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date)
}

export function SourceBadge({ source, className }: { source: string; className?: string }) {
  if (!source) return null
  return (
    <span
      className={cn(
        "rounded-sm bg-[image:var(--brand-gradient)] px-1.5 py-px text-[10px] font-semibold tracking-wide text-white/95",
        className
      )}
    >
      {sourceLabel(source)}
    </span>
  )
}

/**
 * open/closed/merged/done and friends, as a neutral outline chip.
 *
 * Sentence-cased in JS rather than with a CSS transform: the raw values are
 * inconsistent across the nine sources (`open`, `In Progress`, `in_progress`),
 * and `capitalize` would give "In Progress" while `uppercase` shouts. This
 * lifts only the first letter and leaves the rest of the value as stored.
 */
export function StatusBadge({ status }: { status: string }) {
  if (!status) return null
  const text = status.replace(/[_-]+/g, " ")
  return (
    <span className="rounded-sm border border-border bg-muted/60 px-1.5 py-px text-[10px] font-medium text-foreground">
      {text.charAt(0).toUpperCase() + text.slice(1)}
    </span>
  )
}

/** The dotted meta line under a header: source badge, dates, ids. */
export function MetaRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground", className)}>
      {children}
    </div>
  )
}

export function MetaDot() {
  return <span className="text-muted-foreground/40">·</span>
}
