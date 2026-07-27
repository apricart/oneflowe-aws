"use client"

import { SessionProvider } from "next-auth/react"

export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider
      // NextAuth v4 maps a failed session fetch and an empty session to the
      // same `null` value. SessionGuard therefore owns resilient polling/focus
      // checks so a transport failure cannot erase authenticated client state.
      // Initial loading and cross-tab broadcasts remain handled by NextAuth.
      refetchInterval={0}
      refetchOnWindowFocus={false}
      refetchWhenOffline={false}
    >
      {children}
    </SessionProvider>
  )
}
