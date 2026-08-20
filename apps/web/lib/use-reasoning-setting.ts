"use client"

import * as React from "react"

const STORAGE_KEY = "graf:show-reasoning-by-default"

/** Persisted, cross-message default for whether the reasoning panel starts expanded. */
export function useReasoningSetting(): [boolean, (value: boolean) => void] {
  const [showByDefault, setShowByDefault] = React.useState(true)

  React.useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored !== null) setShowByDefault(stored === "true")
  }, [])

  const update = React.useCallback((value: boolean) => {
    setShowByDefault(value)
    window.localStorage.setItem(STORAGE_KEY, String(value))
  }, [])

  return [showByDefault, update]
}
