"use client"

import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"
import { Markdown } from "../chat/markdown"
import {
  MetaDot,
  MetaRow,
  SourceBadge,
  StatusBadge,
  formatTimestamp,
  prop,
  type NodeProperties,
} from "./chrome"
import { parseFieldSections } from "./parse"

/**
 * Renders everything that isn't a chat thread: Confluence pages, Drive docs,
 * Fireflies meeting notes, HubSpot records, and Jira/Linear/GitHub tickets.
 *
 * Two things it adds over rendering the body as one markdown blob. First a
 * masthead, so the provenance a claim gets checked against — source, status,
 * created/updated, url — is visible next to the prose instead of buried in the
 * raw property list. Second, the body is split back into the source fields it
 * was assembled from (see parseFieldSections), which is what turns a Jira
 * ticket from a wall of text into Description / Investigation / Root Cause /
 * Resolution.
 */
export function DocumentView({
  text,
  properties,
  title,
  compact,
}: {
  text: string
  properties?: NodeProperties
  title?: string
  compact?: boolean
}) {
  const sections = React.useMemo(() => parseFieldSections(text), [text])

  const source = prop(properties, "source")
  const status = prop(properties, "status")
  const url = prop(properties, "url")
  const created = formatTimestamp(prop(properties, "created_at"))
  const updated = formatTimestamp(prop(properties, "updated_at"))
  const heading = prop(properties, "title") || title || ""

  // Only Confluence/Drive bodies are authored markdown; the rest are plain
  // prose that happens to contain characters markdown would eat. Rendering
  // them all through Markdown is still right (it passes prose through), but a
  // single-section body with no label shouldn't get section chrome.
  const labelled = sections.some((s) => s.label)

  return (
    <div className="overflow-hidden rounded-md border border-border/70">
      <div className="border-b border-border/70 bg-muted/50 px-3 py-2">
        {heading && <div className="text-[0.85rem] leading-snug font-semibold">{heading}</div>}
        <MetaRow className={heading ? "mt-1" : undefined}>
          <SourceBadge source={source} />
          <StatusBadge status={status} />
          {created && (
            <>
              <span>created {created}</span>
            </>
          )}
          {updated && updated !== created && (
            <>
              <MetaDot />
              <span>updated {updated}</span>
            </>
          )}
          {url && (
            <>
              <MetaDot />
              <span className="truncate font-mono text-[10px]">{url}</span>
            </>
          )}
        </MetaRow>
      </div>

      <div className={cn(compact ? "px-2.5 py-2" : "px-3.5 py-3")}>
        {sections.map((section, i) => (
          <section key={i} className={i > 0 ? "mt-3.5 border-t border-border/30 pt-3" : undefined}>
            {/* Already title-cased by the ingest adapter's titleCase(), so the
                label needs no case transform — see parseFieldSections. */}
            {section.label && labelled && (
              <h4 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{section.label}</h4>
            )}
            <Markdown className={compact ? "space-y-2 text-[0.8rem]" : "text-[0.85rem]"}>{section.body}</Markdown>
          </section>
        ))}
      </div>
    </div>
  )
}
