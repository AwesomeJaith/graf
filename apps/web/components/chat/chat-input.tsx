"use client"

import * as React from "react"
import { ArrowUp } from "lucide-react"

import type { ResponseMode } from "@/lib/trace-types"
import { cn } from "@workspace/ui/lib/utils"

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
            <button
              key={m.key}
              type="button"
              onClick={() => onModeChange(m.key)}
              className={cn(
                "rounded-[5px] px-2 py-1 text-xs font-medium transition-colors",
                mode === m.key ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  )
}
