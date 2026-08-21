"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { Avatar } from "@workspace/ui/components/avatar"
import { Button } from "@workspace/ui/components/button"

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        setSubmitting(true)
        setError(null)

        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        })

        if (response.ok) {
          router.push(searchParams.get("next") ?? "/")
          // The gate lives in the proxy, which decides on the *server* — so the
          // route it was blocking is still cached client-side as a redirect.
          // Refresh discards that, otherwise the push lands back on /login.
          router.refresh()
          return
        }

        const data = (await response.json().catch(() => null)) as { error?: string } | null
        setError(data?.error ?? "Something went wrong")
        setSubmitting(false)
      }}
      className="flex w-full max-w-xs flex-col gap-3"
    >
      <div className="mb-1 flex flex-col items-center gap-2">
        {/* The same mark the app renders next to every assistant message, and
            the same one baked into app/icon.svg — generated from the name
            rather than a separate asset, so there's one drawing to keep. */}
        <Avatar alt="Graf" size={48} />
        <span className="text-2xl font-semibold tracking-tight">Graf</span>
        <p className="text-sm text-muted-foreground">Graph-native enterprise knowledge assistant.</p>
      </div>
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password"
        aria-label="Password"
        className="h-9 rounded-lg border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {/* h-9/rounded-lg/text-sm to match the password field above it — the
          button scale rungs top out at h-8, and a submit sitting a pixel short
          of the field it belongs to reads as a mistake. */}
      <Button
        type="submit"
        size="lg"
        disabled={submitting || !password}
        className="h-9 rounded-lg bg-[image:var(--brand-gradient)] text-sm text-white hover:brightness-110"
      >
        {submitting ? "Checking…" : "Enter"}
      </Button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      {/* `useSearchParams` opts the tree into client rendering, which needs a
          Suspense boundary above it or the whole page bails out of prerender. */}
      <React.Suspense fallback={null}>
        <LoginForm />
      </React.Suspense>
    </div>
  )
}
