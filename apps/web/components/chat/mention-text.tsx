const MENTION_PATTERN = /@\[([^\]]+)\]/g

/** Renders `@[Name]` tokens as an orange badge with white text; everything else passes through as plain text. */
export function MentionText({ text }: { text: string }) {
  const parts = text.split(MENTION_PATTERN)
  // String.split with a capturing global regex alternates [text, capture, text, capture, ...text].
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            className="mx-0.5 inline-flex items-center rounded-md bg-primary px-1.5 py-0.5 text-[0.85em] font-medium text-white"
          >
            @{part}
          </span>
        ) : (
          part
        )
      )}
    </>
  )
}
