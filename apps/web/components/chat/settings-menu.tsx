"use client"

import { Popover } from "@base-ui/react/popover"
import { Switch } from "@base-ui/react/switch"
import { Settings } from "lucide-react"

export function SettingsMenu({
  showReasoningByDefault,
  onShowReasoningByDefaultChange,
}: {
  showReasoningByDefault: boolean
  onShowReasoningByDefaultChange: (value: boolean) => void
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Settings"
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Settings className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="w-64 rounded-md border border-border bg-card p-3 shadow-lg outline-none">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="reasoning-default" className="text-xs text-foreground">
                Show reasoning by default
              </label>
              <Switch.Root
                id="reasoning-default"
                checked={showReasoningByDefault}
                onCheckedChange={onShowReasoningByDefaultChange}
                className="relative h-5 w-8 shrink-0 rounded-full bg-muted transition-colors data-[checked]:bg-primary"
              >
                <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-foreground transition-transform data-[checked]:translate-x-[14px]" />
              </Switch.Root>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
