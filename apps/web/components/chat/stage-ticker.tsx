"use client"

import { AnimatePresence, motion } from "motion/react"
import { useEffect, useState } from "react"

import type { RetrievalStage } from "@/lib/trace-types"
import { ShimmerText } from "./shimmer-text"

const DEFAULT_STAGES: RetrievalStage[] = [
  { key: "resolving", label: "Resolving entities" },
  { key: "searching", label: "Searching graph" },
  { key: "traversing", label: "Following relationships" },
  { key: "evaluating", label: "Evaluating evidence" },
]

// Cycles through pipeline stage labels while a turn is in flight. Advances on
// a timer as a UX placeholder for latency; if the caller has real stage
// events from the API stream, pass `activeIndex` to drive it directly.
export function StageTicker({ stages = DEFAULT_STAGES, activeIndex }: { stages?: RetrievalStage[]; activeIndex?: number }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (activeIndex !== undefined) return
    const id = setInterval(() => setTick((t) => t + 1), 1100)
    return () => clearInterval(id)
  }, [activeIndex])

  const index = activeIndex ?? Math.min(tick, stages.length - 1)
  const stage = stages[index]
  if (!stage) return null

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
      </span>
      <AnimatePresence mode="wait">
        <motion.div
          key={stage.key}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
        >
          <ShimmerText>{stage.label}…</ShimmerText>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
