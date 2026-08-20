"use client"

import * as React from "react"
import { ArrowUp } from "lucide-react"

import type { ResponseMode } from "@/lib/trace-types"
import { Button } from "@workspace/ui/components/button"
import { MentionMenu } from "./mention-menu"

export interface MentionCandidate {
  id: number
  label: string
  name: string
  subtitle?: string
}

const MODES: { key: ResponseMode; label: string }[] = [
  { key: "concise", label: "Concise" },
  { key: "normal", label: "Normal" },
  { key: "verbose", label: "Verbose" },
]

interface ChatInputProps {
  mode: ResponseMode
  onModeChange: (mode: ResponseMode) => void
  onSubmit: (text: string) => void
  disabled?: boolean
}

/**
 * Finds an in-progress "@mention" ending at the cursor. Two forms:
 *  - bare: "...cc @sam" -> stops at the first whitespace (single word).
 *  - bracketed: "...cc @[atlas launch decision]" -> anything up to the
 *    closing "]" (or the cursor, if not closed yet) — lets a phrase with
 *    spaces drive the same semantic search instead of only matching one word.
 */
function findMentionAtCursor(text: string, cursor: number): { start: number; query: string } | null {
  const upToCursor = text.slice(0, cursor)

  const bracketAt = upToCursor.lastIndexOf("@[")
  if (bracketAt !== -1 && !upToCursor.slice(bracketAt + 2).includes("]")) {
    return { start: bracketAt, query: upToCursor.slice(bracketAt + 2) }
  }

  const at = upToCursor.lastIndexOf("@")
  if (at === -1) return null
  const query = upToCursor.slice(at + 1)
  if (query.startsWith("[") || /\s/.test(query)) return null // bracketed-but-closed, or a finished bare token
  const charBefore = at > 0 ? upToCursor[at - 1] : " "
  if (charBefore && !/\s/.test(charBefore)) return null // "foo@bar", not a mention
  return { start: at, query }
}

export function ChatInput({ mode, onModeChange, onSubmit, disabled }: ChatInputProps) {
  const [value, setValue] = React.useState("")
  const [mention, setMention] = React.useState<{ start: number; query: string } | null>(null)
  const [candidates, setCandidates] = React.useState<MentionCandidate[]>([])
  const [loading, setLoading] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    if (!mention || !mention.query) {
      setCandidates([])
      return
    }
    setLoading(true)
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/mentions?q=${encodeURIComponent(mention.query)}`)
        const data = await res.json()
        setCandidates(Array.isArray(data.candidates) ? data.candidates : [])
        setActiveIndex(0)
      } catch {
        setCandidates([])
      } finally {
        setLoading(false)
      }
    }, 200)
    return () => clearTimeout(timeout)
  }, [mention])

  function resize(el: HTMLTextAreaElement) {
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  function selectMention(candidate: MentionCandidate) {
    const el = textareaRef.current
    if (!mention || !el) return
    const cursor = el.selectionStart ?? value.length
    // Always insert the bracketed form, even for a bare "@sam" trigger — a
    // plain "@Full Name " can't be told apart from "@Full" followed by the
    // next word, but "@[Full Name]" is unambiguous and is what the message
    // renderer looks for to draw the mention as a badge.
    const inserted = `@[${candidate.name}]`
    const next = `${value.slice(0, mention.start)}${inserted} ${value.slice(cursor)}`
    setValue(next)
    setMention(null)
    requestAnimationFrame(() => {
      const pos = mention.start + inserted.length + 1
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  function submit() {
    const text = value.trim()
    if (!text || disabled) return
    onSubmit(text)
    setValue("")
    setMention(null)
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }

  return (
    <div className="relative rounded-xl border border-border bg-card p-2">
      {mention && <MentionMenu candidates={candidates} activeIndex={activeIndex} loading={loading} onSelect={selectMention} />}
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder="Ask about your organization… (@ to mention, @[a longer phrase] to search)"
        onChange={(e) => {
          setValue(e.target.value)
          resize(e.target)
          setMention(findMentionAtCursor(e.target.value, e.target.selectionStart ?? e.target.value.length))
        }}
        onKeyDown={(e) => {
          if (mention) {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setActiveIndex((i) => Math.min(i + 1, candidates.length - 1))
              return
            }
            if (e.key === "ArrowUp") {
              e.preventDefault()
              setActiveIndex((i) => Math.max(i - 1, 0))
              return
            }
            if ((e.key === "Enter" || e.key === "Tab") && candidates[activeIndex]) {
              e.preventDefault()
              selectMention(candidates[activeIndex]!)
              return
            }
            if (e.key === "Escape") {
              e.preventDefault()
              setMention(null)
              return
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        className="w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center justify-between px-1 pt-1">
        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
          {MODES.map((m) => (
            <Button
              key={m.key}
              type="button"
              size="sm"
              variant={mode === m.key ? "secondary" : "ghost"}
              aria-pressed={mode === m.key}
              onClick={() => onModeChange(m.key)}
            >
              {m.label}
            </Button>
          ))}
        </div>
        {/* Brand gradient fill rather than the flat `bg-primary` the default
            variant gives. The variant's `hover:bg-primary/80` can't show
            through an opaque background-image, so the hover affordance becomes
            brightness instead of colour (`transition-all` already animates it). */}
        <Button
          type="button"
          size="icon"
          onClick={submit}
          disabled={disabled || !value.trim()}
          aria-label="Send"
          className="bg-[image:var(--brand-gradient)] hover:brightness-110"
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
  )
}
