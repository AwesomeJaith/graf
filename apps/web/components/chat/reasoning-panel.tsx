"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronRight } from "lucide-react"

import { Markdown } from "./markdown"

export function ReasoningPanel({ reasoning, defaultExpanded }: { reasoning: string; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = React.useState(defaultExpanded)

  // Same reason as in <EvidencePanel>: the setting hydrates from localStorage
  // after mount, so sampling it once at mount can miss the stored value.
  React.useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded])

  if (!reasoning) return null

  return (
    <div className="rounded-md border border-border/70 bg-card/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ type: "spring", stiffness: 400, damping: 30 }} className="flex">
          <ChevronRight className="size-3.5" />
        </motion.span>
        Reasoning
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 45 }}
            className="overflow-hidden"
          >
            <Markdown className="px-3 pb-3 text-xs leading-relaxed text-muted-foreground">{reasoning}</Markdown>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
