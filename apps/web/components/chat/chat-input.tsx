"use client"

import * as React from "react"
import { ArrowUp } from "lucide-react"

import type { ResponseMode } from "@/lib/trace-types"
import { Button } from "@workspace/ui/components/button"

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

export function ChatInput({ mode, onModeChange, onSubmit, disabled }: ChatInputProps) {
  const [value, setValue] = React.useState("")
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  function submit() {
    const text = value.trim()
    if (!text || disabled) return
    onSubmit(text)
    setValue("")
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }

  return (
    <div className="rounded-xl border border-border bg-card p-2">
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder="Ask about your organization…"
        onChange={(e) => {
          setValue(e.target.value)
          e.target.style.height = "auto"
          e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
        }}
        onKeyDown={(e) => {
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
        <Button type="button" size="icon" onClick={submit} disabled={disabled || !value.trim()} aria-label="Send">
          <ArrowUp />
        </Button>
      </div>
    </div>
  )
}
