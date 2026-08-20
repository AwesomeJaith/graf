"use client"

import { SquarePen, Trash2 } from "lucide-react"

import type { Conversation } from "@/lib/use-conversations"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onDelete,
}: {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="flex h-full w-60 shrink-0 flex-col border-r border-border/70 px-2.5 py-3">
      <Button variant="outline" size="sm" className="w-full justify-start gap-2" onClick={onNewChat}>
        <SquarePen className="size-3.5" />
        New chat
      </Button>
      <div className="mt-3 flex-1 space-y-0.5 overflow-y-auto">
        {conversations.map((c) => (
          <div key={c.id} className="group relative">
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn(
                "block w-full truncate rounded-md px-2.5 py-1.5 pr-7 text-left text-xs transition-colors",
                c.id === activeId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              )}
            >
              {c.title}
            </button>
            <button
              type="button"
              aria-label="Delete chat"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(c.id)
              }}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
