import * as React from "react"
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar"

import { cn } from "@workspace/ui/lib/utils"

const DEFAULT_SIZE = 32

interface AvatarProps extends React.ComponentProps<typeof AvatarPrimitive.Root> {
  src?: string | null
  alt: string
  size?: number
}

function Avatar({ src, alt, size = DEFAULT_SIZE, className, style, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-[28%]",
        className
      )}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      {src ? <AvatarPrimitive.Image className="size-full object-cover" src={src} alt={alt} /> : null}
      <AvatarPrimitive.Fallback className="size-full">
        <AvatarGradient name={alt} size={size} />
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}

// Deterministic per-name gradient identicon: three overlapping shapes,
// hashed from the name, so the same person always renders the same avatar.
const PALETTE = ["#D74C26", "#F0A26B", "#373737", "#8C8C8C"]

function hash(input: string) {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

function unit(seed: number, max: number, salt = 0) {
  return ((seed * (salt + 7)) % 1000) / 1000 * max
}

function AvatarGradient({ name, size }: { name: string; size: number }) {
  const seed = hash(name || "?")
  const maskId = React.useId()
  const initials = React.useMemo(() => getInitials(name), [name])

  const shapes = [1, 2].map((i) => ({
    color: PALETTE[(seed + i) % PALETTE.length],
    translateX: unit(seed, size / 6, i) - size / 12,
    translateY: unit(seed, size / 6, i + 3) - size / 12,
    rotate: unit(seed, 360, i * 2),
    scale: 1.1 + unit(seed, 0.5, i),
  }))

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={name}>
      <defs>
        <mask id={maskId}>
          <rect width={size} height={size} rx={size * 0.28} fill="#fff" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <rect width={size} height={size} fill="#373737" />
        {shapes.map((s, i) => (
          <rect
            key={i}
            x={size * 0.15}
            y={size * 0.15}
            width={size * 0.7}
            height={size * 0.7}
            fill={s.color}
            opacity={0.85}
            style={{ mixBlendMode: i === 0 ? "normal" : "overlay" }}
            transform={`translate(${s.translateX} ${s.translateY}) rotate(${s.rotate} ${size / 2} ${size / 2}) scale(${s.scale})`}
          />
        ))}
        <text
          x="50%"
          y="52%"
          dominantBaseline="middle"
          textAnchor="middle"
          fill="#fff"
          fontSize={size * 0.36}
          fontWeight={600}
          style={{ mixBlendMode: "overlay" }}
        >
          {initials}
        </text>
      </g>
    </svg>
  )
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

export { Avatar }
