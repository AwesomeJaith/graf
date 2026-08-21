const MENTION_PATTERN = /@\[([^\]]+)\]/g

/**
 * Renders `@[Name]` tokens as a brand-gradient badge with white text;
 * everything else passes through as plain text.
 *
 * Two bits of geometry, both keyed to the bubble in <UserTurn>. The radius is
 * concentric — inner radius + inset = outer radius — so the badge's corners run
 * parallel to the bubble's instead of cutting across them. Hence the calc
 * rather than a `rounded-*` step: the bubble is `rounded-2xl`, which this theme
 * derives as `--radius * 1.8`, and its inset is `p-2.5` (0.625rem), so no step
 * on the scale is the right value. Writing it as arithmetic on the same token
 * also keeps it correct if `--radius` is retuned.
 *
 * And there's no horizontal margin, which is what makes the gap even on all
 * three sides: a badge that opens or closes a line sits exactly one inset from
 * that edge, the same distance as from the top. Mid-sentence separation comes
 * from the spaces already in the text either side of the token.
 *
 * No font-size and no vertical padding, both deliberate. Inheriting the
 * bubble's size and its (unitless, so ratio-inherited) line-height makes the
 * badge box exactly the line's strut — 14px text in a 20px box — so it sits on
 * the surrounding baseline without pushing its line taller than its
 * neighbours. Any vertical padding would break that: an inline-flex box is
 * baseline-aligned on its content, so padding grows the line box around it and
 * the badge stops sharing a line with the text either side of it.
 */
export function MentionText({ text }: { text: string }) {
  const parts = text.split(MENTION_PATTERN)
  // String.split with a capturing global regex alternates [text, capture, text, capture, ...text].
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            className="inline-flex items-center rounded-[calc(var(--radius)*1.8-0.625rem)] bg-[image:var(--brand-gradient-soft)] px-1.5 font-medium text-white"
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
