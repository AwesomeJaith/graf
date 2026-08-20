// Parsers for the body text stored on content nodes.
//
// The benchmark keeps each document's body as one opaque string, but the
// strings are not shapeless: a Slack node holds a whole thread, a Gmail node a
// whole mail chain, and a Jira/Confluence node a set of labelled fields
// (packages/bench/src/adapt.ts joins the source's declared `content_field_names`
// with a `Title:` prefix each). Rendering all of that as one markdown blob
// throws away structure the source clearly has, so these functions recover it.
//
// Everything here degrades rather than throws: a parser that can't find its
// structure returns an empty array, and the caller falls back to plain
// markdown. That matters because these bodies come from 500k+ documents across
// nine sources — the long tail will contain shapes we haven't seen.

export interface SlackMessage {
  speaker: string
  text: string
}

export interface SlackGroup {
  speaker: string
  messages: string[]
}

export interface EmailMessage {
  from: string
  to: string
  cc: string
  date: string
  subject: string
  body: string
}

export interface FieldSection {
  label?: string
  body: string
}

/**
 * Turns literal backslash-n sequences into real newlines.
 *
 * The Gmail bodies in the full corpus are double-escaped: the newlines *inside*
 * a message survive as the two characters `\` + `n`, while the newlines
 * *between* messages are real. So an unmodified body renders as four
 * enormous single lines. Applied to every source, since a body that has no
 * literal escapes is unaffected.
 */
export function unescapeLiteralNewlines(text: string): string {
  if (!text.includes("\\n") && !text.includes("\\t")) return text
  return text.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t")
}

/**
 * Words that are legitimately lowercase inside a person's name, so
 * "Ana de Souza" isn't rejected as a non-name by the capitalisation rule below.
 */
const NAME_PARTICLES = new Set(["de", "del", "der", "den", "van", "von", "la", "le", "du", "da", "dos", "bin", "al"])

/**
 * Whether `raw` looks like a person or bot name rather than a sentence fragment.
 *
 * This is the whole difficulty of parsing the Slack bodies. A line is
 * `Speaker: message`, but messages themselves are full of colons —
 * "Alex Chen: Blockers: CI flake on the gateway e2e" is one message from one
 * person, not a message from "Blockers". Splitting on the *first* colon handles
 * that case, and this check rejects the remaining false positives, where a
 * message's own continuation line begins with a capitalised word and a colon.
 *
 * The rule: one to four words, the first capitalised, the rest capitalised or a
 * known particle. That accepts "Alex Chen", "Dr. Maya Srinivasan" and
 * "Supportbot" while rejecting "What I did", "quick note" and "from ticket".
 * It does still accept a bare capitalised word like "Blockers", which is why
 * unparsed lines are appended to the previous message rather than dropped — a
 * mis-split shows up as an extra speaker, never as lost text.
 */
function looksLikeName(raw: string): boolean {
  const words = raw.trim().split(/\s+/)
  if (words.length === 0 || words.length > 4) return false
  return words.every((word, i) => {
    if (i > 0 && NAME_PARTICLES.has(word.toLowerCase())) return true
    return /^\p{Lu}[\p{L}'’.-]*$/u.test(word)
  })
}

const SPEAKER_LINE = /^([^:]{1,40}):[ \t]+(.*)$/

/**
 * Recovers the individual messages in a Slack thread body.
 *
 * Both layouts in the corpus are handled: the full corpus puts one
 * `Speaker: message` per line, the committed sample separates messages with
 * blank lines and lets a message run over several lines. A line that doesn't
 * open with a plausible speaker is treated as a continuation of the message
 * above it, which covers the multi-line case and the bullet lists inside it.
 */
export function parseSlackThread(text: string): SlackMessage[] {
  const messages: SlackMessage[] = []
  for (const line of unescapeLiteralNewlines(text).split("\n")) {
    const match = line.match(SPEAKER_LINE)
    if (match && looksLikeName(match[1]!)) {
      messages.push({ speaker: match[1]!.trim(), text: match[2] ?? "" })
      continue
    }
    const previous = messages[messages.length - 1]
    if (previous) previous.text += `\n${line}`
    else if (line.trim()) messages.push({ speaker: "", text: line })
  }
  return messages
    .map((m) => ({ speaker: m.speaker, text: m.text.trim() }))
    .filter((m) => m.speaker !== "" || m.text !== "")
}

/**
 * Collapses runs of consecutive messages from the same speaker, the way a chat
 * client does — a standup where one person posts four lines in a row should
 * read as one block with one name on it, not four repetitions of their avatar.
 */
export function groupSlackMessages(messages: SlackMessage[]): SlackGroup[] {
  const groups: SlackGroup[] = []
  for (const message of messages) {
    const last = groups[groups.length - 1]
    if (last && last.speaker === message.speaker) last.messages.push(message.text)
    else groups.push({ speaker: message.speaker, messages: [message.text] })
  }
  return groups
}

/** Bots post alongside people in these threads; a chat client badges them. */
export function isBotSpeaker(speaker: string): boolean {
  return /bot$|^ci$|webhook|alerts?$/i.test(speaker.trim())
}

const HEADER_LINE = /^(From|To|Cc|Bcc|Date|Subject|Reply-To):[ \t]*(.*)$/i

/**
 * Recovers the individual emails in a Gmail thread body.
 *
 * Each email is an RFC-ish header block (`From:`/`To:`/`Cc:`/`Date:`/`Subject:`)
 * then a blank line then its body. Splitting on a lookahead for `From:` rather
 * than on the sample corpus's `---` rules means both corpora parse: the full
 * corpus has no separator line at all.
 */
export function parseEmailThread(text: string): EmailMessage[] {
  const normalized = unescapeLiteralNewlines(text)
  const chunks = normalized.split(/\n(?=From:[ \t])/)
  const messages: EmailMessage[] = []

  for (const chunk of chunks) {
    // The sample corpus's `---` separator lands at the tail of the preceding
    // chunk once the split is done, so it's stripped here rather than up front.
    const lines = chunk.replace(/^[ \t]*-{3,}[ \t]*$/gm, "").split("\n")
    const headers: Record<string, string> = {}
    let i = 0
    for (; i < lines.length; i++) {
      const match = lines[i]!.match(HEADER_LINE)
      if (!match) break
      headers[match[1]!.toLowerCase()] = match[2]!.trim()
    }
    if (!headers.from) continue
    messages.push({
      from: headers.from ?? "",
      to: headers.to ?? "",
      cc: headers.cc ?? "",
      date: headers.date ?? "",
      subject: headers.subject ?? "",
      body: lines.slice(i).join("\n").trim(),
    })
  }
  return messages
}

/** Splits `Name <addr@host>` into its parts; either half may be absent. */
export function parseAddress(raw: string): { name: string; address: string } {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (match) return { name: match[1]!.trim(), address: match[2]!.trim() }
  const bare = raw.trim()
  return bare.includes("@") ? { name: "", address: bare } : { name: bare, address: "" }
}

const FIELD_LABEL = /^([A-Z][A-Za-z0-9 _-]{0,40}):$/

/**
 * Splits a body into the source fields it was assembled from.
 *
 * When a document declares more than one content field, adapt.ts writes
 * `Title Case Field Name:` on its own line above each one. Recovering those
 * gives a Jira ticket its Description / Investigation / Root Cause / Resolution
 * sections back instead of one undifferentiated wall of text. A body with no
 * such lines comes back as a single unlabelled section.
 */
export function parseFieldSections(text: string): FieldSection[] {
  const sections: FieldSection[] = []
  let current: FieldSection = { body: "" }
  for (const line of unescapeLiteralNewlines(text).split("\n")) {
    const match = line.match(FIELD_LABEL)
    if (match) {
      if (current.label !== undefined || current.body.trim() !== "") sections.push(current)
      current = { label: match[1]!.trim(), body: "" }
      continue
    }
    current.body += current.body === "" ? line : `\n${line}`
  }
  if (current.label !== undefined || current.body.trim() !== "") sections.push(current)
  return sections
    .map((s) => ({ label: s.label, body: s.body.trim() }))
    .filter((s) => s.label !== undefined || s.body !== "")
}
