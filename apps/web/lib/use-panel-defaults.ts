"use client"

import * as React from "react"

/**
 * A boolean setting persisted in localStorage.
 *
 * Read in an effect rather than in the initial state because the first render
 * has no localStorage to read — initialising from it would make the server
 * markup disagree with the client's first paint. So consumers see `fallback`
 * for one render, which is why the panels these drive re-sync when the value
 * changes instead of only sampling it on mount.
 */
function usePersistedFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = React.useState(fallback)

  React.useEffect(() => {
    const stored = window.localStorage.getItem(key)
    if (stored !== null) setValue(stored === "true")
  }, [key])

  const update = React.useCallback(
    (next: boolean) => {
      setValue(next)
      window.localStorage.setItem(key, String(next))
    },
    [key]
  )

  return [value, update]
}

/** Whether the reasoning panel starts expanded. */
export function useReasoningSetting(): [boolean, (value: boolean) => void] {
  return usePersistedFlag("graf:show-reasoning-by-default", true)
}

/**
 * Whether the evidence panel starts expanded.
 *
 * Off by default, which is the panel's whole premise: the answer stays the
 * focus and the audit trail is one click away. But that's a click per answer
 * for anyone whose job is reading the trace, which is what this is for.
 */
export function useEvidenceSetting(): [boolean, (value: boolean) => void] {
  return usePersistedFlag("graf:show-evidence-by-default", false)
}
