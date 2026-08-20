"use client"

import { cn } from "@workspace/ui/lib/utils"

// Animated gradient-sweep text for in-progress states ("Resolving entities…").
// CSS-only (no JS interval) so it's cheap to keep mounted while a stage runs.
export function ShimmerText({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "bg-[length:200%_100%] bg-clip-text text-transparent [animation:shimmer_1.6s_linear_infinite]",
        "bg-[image:var(--brand-gradient-sweep)]",
        className
      )}
    >
      {children}
    </span>
  )
}
