"use client"

import { createContext, useContext, useEffect, useMemo, useState, useCallback, type ReactNode } from "react"
import { useSession } from "next-auth/react"

// Types
// GROUP_USER shares the admin shell, so it needs a context entry too. Its reach
// is a set of branches resolved on the server from its own assignments, so it
// is pinned to its organization here and never to a branch — the branch filter
// it would otherwise carry is not the client's to decide.
type Role = "SUPER_ADMIN" | "HEAD_OFFICE" | "BRANCH_ADMIN" | "GROUP_USER" | "VIEWER" | "FINANCE"

interface AppContextValue {
  // Current context
  organizationId: string | null
  branchId: string | null
  branchIds: string[]

  // User info
  userRole: Role | null
  userOrgId: number | null
  userBranchId: number | null

  // Actions
  setOrganizationId: (id: string | null) => void
  setBranchId: (id: string | null) => void
  setBranchIds: (ids: string[]) => void
  resetContext: () => void

  // UI State
  isInitialized: boolean
}

const AppContext = createContext<AppContextValue | undefined>(undefined)

const STORAGE_KEY = "oneflowe:app-context"

type SavedContext = { organizationId: string | null; branchId: string | null; branchIds: string[] }

function loadSavedContext(): SavedContext | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) as SavedContext : null
  } catch (error) {
    console.warn("Unable to restore the saved application context:", error)
    return null
  }
}

function initializeRoleContext(options: {
  userRole: Role | null
  userOrgId: number | null
  userBranchId: number | null
  savedContext: SavedContext | null
  setOrganizationId: (value: string | null) => void
  setBranchId: (value: string | null) => void
  setBranchIds: (value: string[]) => void
}): void {
  const { userRole, userOrgId, userBranchId, savedContext, setOrganizationId, setBranchId, setBranchIds } = options
  if (userRole === "SUPER_ADMIN") {
    setOrganizationId(savedContext?.organizationId || null)
    setBranchId(savedContext?.branchId || null)
    setBranchIds(savedContext?.branchIds || [])
  } else if (userRole === "HEAD_OFFICE" && userOrgId) {
    setOrganizationId(String(userOrgId))
    setBranchId(savedContext?.branchId || null)
    setBranchIds(savedContext?.branchIds || [])
  } else if (userRole === "BRANCH_ADMIN" && userOrgId && userBranchId) {
    setOrganizationId(String(userOrgId))
    setBranchId(String(userBranchId))
    setBranchIds([String(userBranchId)])
  } else if (userRole === "GROUP_USER" && userOrgId) {
    // Pinned to its tenant, with no branch selection: leaving the branch filter
    // empty lets each endpoint apply this role's assigned branch set itself.
    setOrganizationId(String(userOrgId))
    setBranchId(null)
    setBranchIds([])
  } else if (userRole === "FINANCE") {
    // Finance picks among its assigned organizations like Super Admin does,
    // but starts on all of them: a saved selection may name an organization
    // it no longer reaches, which every endpoint would refuse.
    setOrganizationId(null)
    setBranchId(null)
    setBranchIds([])
  } else if (userRole === "VIEWER" && userOrgId) {
    // Read-only. Always pinned to its tenant; pinned to a branch as well when
    // the account carries one, in which case the filter is not offered. The
    // endpoints apply the same rule server-side (`resolveViewerScope`), so this
    // only decides what the dashboard asks for, never what it may have.
    setOrganizationId(String(userOrgId))
    setBranchId(userBranchId ? String(userBranchId) : null)
    setBranchIds(userBranchId ? [String(userBranchId)] : savedContext?.branchIds || [])
  }
}

export function AppContextProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { data: session, status } = useSession()

  const [organizationIdState, setOrganizationIdState] = useState<string | null>(null)
  const [branchIdState, setBranchIdState] = useState<string | null>(null)
  const [branchIdsState, setBranchIdsState] = useState<string[]>([])
  const [isInitialized, setIsInitialized] = useState(false)
  const organizationId = organizationIdState
  const branchId = branchIdState
  const branchIds = branchIdsState

  // Get user info from session
  const userRole = (session?.user as any)?.role || null
  const userOrgId = (session?.user as any)?.organizationId || null
  const userBranchId = (session?.user as any)?.branchId || null

  // Initialize context from session and localStorage
  useEffect(() => {
    if (status === "loading") return

    if (!session) {
      setIsInitialized(true)
      return
    }

    initializeRoleContext({
      userRole,
      userOrgId,
      userBranchId,
      savedContext: loadSavedContext(),
      setOrganizationId: setOrganizationIdState,
      setBranchId: setBranchIdState,
      setBranchIds: setBranchIdsState,
    })

    setIsInitialized(true)
  }, [session, status, userRole, userOrgId, userBranchId])

  // Persist to localStorage whenever context changes
  useEffect(() => {
    if (!isInitialized) return

    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ organizationId, branchId, branchIds })
      )
    } catch (error) {
      console.warn("Unable to save the application context:", error)
    }
  }, [organizationId, branchId, branchIds, isInitialized])

  // Actions
  const setOrganizationId = useCallback((id: string | null) => {
    setOrganizationIdState(id)
    // Clear branch when organization changes
    if (id !== organizationId) {
      setBranchIdState(null)
      setBranchIdsState([])
    }
  }, [organizationId])

  const setBranchId = useCallback((id: string | null) => {
    setBranchIdState(id)
    if (id && !branchIds.includes(id)) {
      setBranchIdsState([id])
    } else if (!id) {
      setBranchIdsState([])
    }
  }, [branchIds])

  const setBranchIds = useCallback((ids: string[]) => {
    setBranchIdsState(ids)
    // If exactly one, sync to single branchId for backward compatibility
    if (ids.length === 1) {
      setBranchIdState(ids[0])
    } else {
      setBranchIdState(null)
    }
  }, [])

  const resetContext = useCallback(() => {
    if (userRole === "SUPER_ADMIN" || userRole === "FINANCE") {
      setOrganizationIdState(null)
      setBranchIdState(null)
      setBranchIdsState([])
    } else if ((userRole === "HEAD_OFFICE" || userRole === "GROUP_USER") && userOrgId) {
      setOrganizationIdState(String(userOrgId))
      setBranchIdState(null)
      setBranchIdsState([])
    } else if (userRole === "BRANCH_ADMIN" && userOrgId && userBranchId) {
      setOrganizationIdState(String(userOrgId))
      setBranchIdState(String(userBranchId))
      setBranchIdsState([String(userBranchId)])
    } else if (userRole === "VIEWER" && userOrgId) {
      // Resetting a pinned Viewer returns it to its own branch, not to the
      // whole tenant.
      setOrganizationIdState(String(userOrgId))
      setBranchIdState(userBranchId ? String(userBranchId) : null)
      setBranchIdsState(userBranchId ? [String(userBranchId)] : [])
    }
  }, [userRole, userOrgId, userBranchId])

  const value = useMemo<AppContextValue>(() => ({
    organizationId,
    branchId,
    branchIds,
    userRole,
    userOrgId,
    userBranchId,
    setOrganizationId,
    setBranchId,
    setBranchIds,
    resetContext,
    isInitialized,
  }), [organizationId, branchId, branchIds, userRole, userOrgId, userBranchId, setOrganizationId, setBranchId, setBranchIds, resetContext, isInitialized])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

// Hook to use the app context
export function useAppContext() {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error("useAppContext must be used within AppContextProvider")
  }
  return context
}
