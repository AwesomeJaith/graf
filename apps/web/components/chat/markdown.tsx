import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@workspace/ui/lib/utils"

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "space-y-3 text-[0.9rem] leading-relaxed",
        "[&_strong]:font-semibold [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
        "[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]",
        "[&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:overflow-x-auto",
        "[&_table]:w-full [&_table]:text-sm [&_th]:border-b [&_th]:border-border [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold",
        "[&_td]:border-b [&_td]:border-border/60 [&_td]:py-1.5",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}
