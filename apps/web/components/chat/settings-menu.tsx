"use client"

import { Popover } from "@base-ui/react/popover"
import { Switch } from "@base-ui/react/switch"
import { Settings } from "lucide-react"

/** One labelled switch. Factored out so the two rows can't drift apart. */
function SettingRow({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  checked: boolean
  onCheckedChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-xs text-foreground">
        {label}
      </label>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative flex h-5 w-8 shrink-0 items-center rounded-full bg-muted p-0.5 transition-colors data-[checked]:bg-[image:var(--brand-gradient)]"
      >
        <Switch.Thumb className="block size-4 rounded-full bg-foreground transition-transform data-[checked]:translate-x-3" />
      </Switch.Root>
    </div>
  )
}

export function SettingsMenu({
  showReasoningByDefault,
  onShowReasoningByDefaultChange,
  showEvidenceByDefault,
  onShowEvidenceByDefaultChange,
}: {
  showReasoningByDefault: boolean
  onShowReasoningByDefaultChange: (value: boolean) => void
  showEvidenceByDefault: boolean
  onShowEvidenceByDefaultChange: (value: boolean) => void
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
          <Popover.Popup className="w-64 space-y-2.5 rounded-md border border-border bg-card p-3 shadow-lg outline-none">
            <SettingRow
              id="reasoning-default"
              label="Show reasoning by default"
              checked={showReasoningByDefault}
              onCheckedChange={onShowReasoningByDefaultChange}
            />
            <SettingRow
              id="evidence-default"
              label="Show evidence by default"
              checked={showEvidenceByDefault}
              onCheckedChange={onShowEvidenceByDefaultChange}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
