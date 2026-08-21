import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

import { COOKIE_NAME, verifySessionToken } from "@/lib/session"

/**
 * Puts every page and API route behind a single shared password
 * (`SITE_PASSWORD`).
 *
 * The gate is about cost, not secrecy: an open `/api/chat` is an open door to
 * the account's Bedrock spend and to a HydraDB collection holding a full
 * enterprise corpus, and a crawler that finds the deployment would happily
 * walk both. So the API routes are gated as firmly as the pages — an
 * unauthenticated request there gets a 401 rather than a redirect, since a
 * fetch has no use for an HTML login form.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // The one route that has to be reachable unauthenticated — it's what issues
  // the session in the first place.
  if (pathname === "/api/auth/login") return NextResponse.next()

  const authenticated = await verifySessionToken(request.cookies.get(COOKIE_NAME)?.value)

  if (pathname === "/login") {
    // Already signed in: the form would be a dead end, so continue to wherever
    // the redirect was headed instead of showing it again.
    if (authenticated) {
      const next = request.nextUrl.searchParams.get("next") ?? "/"
      return NextResponse.redirect(new URL(next, request.url))
    }
    return NextResponse.next()
  }

  if (authenticated) return NextResponse.next()

  if (pathname.startsWith("/api")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set("next", pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // Everything except Next's own static/image assets and files with an
  // extension (icon.svg) — those aren't sensitive, and gating them would stop
  // the login page's own shell from rendering.
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
}
