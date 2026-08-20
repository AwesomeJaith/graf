"use client"

import * as React from "react"

import type { TraceNode } from "@/lib/trace-types"
import { DocumentView } from "./document-view"
import { EmailThread } from "./email-thread"
import { SlackThread } from "./slack-thread"
import { prop } from "./chrome"
import { parseEmailThread, parseSlackThread } from "./parse"

/**
 * Renders a node's body in the shape of the tool it came from — a Slack thread
 * as a conversation, a Gmail thread as a mail chain, everything else as a
 * document with a masthead.
 *
 * Dispatch is on the node's `source` property, which every ingested content
 * node carries (`slack`, `gmail`, `confluence`, `jira`, ...), rather than on
 * its graph label: label tells you a Slack thread and an email are both
 * `Message`, which is the distinction that matters least here.
 *
 * Parsing happens here rather than in the renderers so that "this body doesn't
 * actually have the structure its source implies" is handled in one place. The
 * corpus is 500k+ documents across nine sources and the parsers are
 * heuristic — anything they can't make sense of falls back to DocumentView,
 * which renders the body as-is and can't fail.
 */
export function ContentView({ node, compact }: { node: TraceNode; compact?: boolean }) {
  const text = node.content ?? ""
  const source = prop(node.properties, "source")

  const slack = React.useMemo(() => (source === "slack" ? parseSlackThread(text) : []), [source, text])
  const email = React.useMemo(() => (source === "gmail" ? parseEmailThread(text) : []), [source, text])

  if (!text.trim()) return null

  // A thread needs at least one attributed message to be worth drawing as one;
  // an unattributed blob is just a document that happens to live in Slack.
  if (slack.some((m) => m.speaker)) {
    return <SlackThread messages={slack} properties={node.properties} compact={compact} />
  }
  if (email.length > 0) {
    return <EmailThread messages={email} properties={node.properties} subject={node.label} compact={compact} />
  }
  return <DocumentView text={text} properties={node.properties} title={node.label} compact={compact} />
}
