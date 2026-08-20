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

// Deterministic per-name gradient identicon — same generator (hash, unit
// spread, color pick, two overlapping blurred paths) and palette as the
// /Users/noodles/Downloads/fallback-avatar reference, so the same name
// always renders the same avatar. The outer <Avatar> root clips this to a
// rounded square (not the reference's own circular mask), per the brief.
const PALETTE = ["#F6C750", "#E63525", "#050D4C", "#D4EBEE"]
const BASE = 40

function hash(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    const character = name.charCodeAt(i)
    h = (h << 5) - h + character
    h = h & h
  }
  return Math.abs(h)
}

function getDigit(number: number, ntn: number) {
  return Math.floor((number / Math.pow(10, ntn)) % 10)
}

function getUnit(number: number, range: number, index?: number) {
  const value = number % range
  if (index && getDigit(number, index) % 2 === 0) return -value
  return value
}

function getRandomColor(number: number, colors: string[], range: number) {
  return colors[number % range]!
}

function generateColors(name: string, colors: string[]) {
  const numFromName = hash(name)
  const range = colors.length
  return Array.from({ length: 3 }, (_, i) => ({
    color: getRandomColor(numFromName + i, colors, range),
    translateX: getUnit(numFromName * (i + 1), BASE / 10, 1),
    translateY: getUnit(numFromName * (i + 1), BASE / 10, 2),
    scale: 1.2 + getUnit(numFromName * (i + 1), BASE / 20) / 10,
    rotate: getUnit(numFromName * (i + 1), 360, 1),
  }))
}

// The reference paths are authored against a canvas roughly this big
// (coordinates run out to ~86); the artwork's viewBox is fixed to that
// regardless of the rendered `size`, so `width`/`height` scale the whole
// pattern down to fit instead of cropping it into a near-solid tile at
// chat-avatar sizes.
const CANVAS = 90

function AvatarGradient({ name, size }: { name: string; size: number }) {
  const titleId = React.useId()
  const maskId = React.useId()
  const filterId = React.useId()
  const properties = React.useMemo(() => generateColors(name || "?", PALETTE), [name])

  return (
    <svg viewBox={`0 0 ${CANVAS} ${CANVAS}`} width={size} height={size} fill="none" role="img" aria-describedby={titleId}>
      <title id={titleId}>{name}</title>
      <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={CANVAS} height={CANVAS}>
        <rect width={CANVAS} height={CANVAS} fill="#fff" />
      </mask>
      <g mask={`url(#${maskId})`}>
        <rect width={CANVAS} height={CANVAS} fill={properties[0]!.color} />
        <path
          filter={`url(#${filterId})`}
          d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z"
          fill={properties[1]!.color}
          transform={`translate(${properties[1]!.translateX} ${properties[1]!.translateY}) rotate(${properties[1]!.rotate} ${CANVAS / 2} ${CANVAS / 2}) scale(${properties[1]!.scale})`}
        />
        <path
          filter={`url(#${filterId})`}
          style={{ mixBlendMode: "overlay" }}
          d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z"
          fill={properties[2]!.color}
          transform={`translate(${properties[2]!.translateX} ${properties[2]!.translateY}) rotate(${properties[2]!.rotate} ${CANVAS / 2} ${CANVAS / 2}) scale(${properties[2]!.scale})`}
        />
      </g>
      <defs>
        <filter id={filterId} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity={0} result="BackgroundImageFix" />
          <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation={7} result="effect1_foregroundBlur" />
        </filter>
      </defs>
    </svg>
  )
}

export { Avatar }
