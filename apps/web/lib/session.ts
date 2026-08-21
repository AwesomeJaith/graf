import "server-only"
import { SignJWT, jwtVerify } from "jose"

/**
 * One shared password gates the whole app, so the hosted demo can be handed to
 * judges without standing up accounts. There is no identity to carry, so the
 * only claim in the token is "this cookie was issued by us" — signed rather
 * than a bare flag so the cookie can't be forged by setting it by hand.
 */
const COOKIE_NAME = "graf_session"
const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60

function secretKey() {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error("SESSION_SECRET is not set")
  return new TextEncoder().encode(secret)
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS)
    .sign(secretKey())
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] })
    return payload.authenticated === true
  } catch {
    return false
  }
}

export { COOKIE_NAME, SESSION_DURATION_SECONDS }
