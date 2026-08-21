import { timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { z } from "zod"

import { COOKIE_NAME, SESSION_DURATION_SECONDS, createSessionToken } from "@/lib/session"

const loginSchema = z.object({ password: z.string().min(1) })

function passwordMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch rather than returning false.
  // Length isn't the secret here (the password's length isn't worth protecting),
  // so short-circuit rather than padding to a fixed width.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const sitePassword = process.env.SITE_PASSWORD
  if (!sitePassword) {
    return Response.json({ error: "SITE_PASSWORD is not configured" }, { status: 500 })
  }

  const parsed = loginSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: "Password is required" }, { status: 400 })
  }

  if (!passwordMatches(parsed.data.password, sitePassword)) {
    return Response.json({ error: "Incorrect password" }, { status: 401 })
  }

  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, await createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  })

  return Response.json({ success: true })
}
