import {
  User,
  FolderKanban,
  FileText,
  MessageSquare,
  Hash,
  CheckSquare,
  GitBranch,
  CircleAlert,
  Scale,
  CalendarClock,
  Building2,
  Circle,
} from "lucide-react"

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Person: User,
  Organization: Building2,
  Project: FolderKanban,
  Document: FileText,
  Message: MessageSquare,
  Channel: Hash,
  Task: CheckSquare,
  Repository: GitBranch,
  Issue: CircleAlert,
  Decision: Scale,
  Event: CalendarClock,
}

export function NodeIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = ICONS[kind] ?? Circle
  return <Icon className={className} />
}
