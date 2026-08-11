"use client"

import type React from "react"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

type Role = "SUPER_ADMIN" | "HEAD_OFFICE" | "BRANCH_ADMIN"

type OrgBranchContextValue = {
  organizationId: string | null
  branchId: string | null
  level: "NONE" | "ORGANIZATION" | "BRANCH"
  setOrganization: (id: string | null) => void
  setBranch: (id: string | null) => void
  reset: () => void
  role: Role
  setRole: (r: Role) => void
  canManageOrganization: boolean
  canManageBranch: boolean
  version: number
}

const OrgBranchContext = createContext<OrgBranchContextValue | undefined>(undefined)

const STORAGE_KEY = "oneflowe:org-branch-context"

export function OrgBranchProvider({
  children,
  initialRole = "HEAD_OFFICE",
}: Readonly<{
  children: React.ReactNode
  initialRole?: Role
}>) {
  const [organizationId, setOrganizationId] = useState<string | null>(null)
  const [branchId, setBranchId] = useState<string | null>(null)
  const [role, setRole] = useState<Role>(initialRole)
  const [version, setVersion] = useState<number>(0)

  // hydrate from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { organizationId?: string | null; branchId?: string | null }
        setOrganizationId(parsed.organizationId ?? null)
        setBranchId(parsed.branchId ?? null)
      }
    } catch {}
  }, [])

  // persist to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ organizationId, branchId }))
    } catch {}
  }, [organizationId, branchId])

  const setOrganization = useCallback((id: string | null) => {
    setOrganizationId(id)
    setBranchId(null) // always clear branch when organization changes to avoid stale cross-org branch selection
    setVersion((v) => v + 1)
    try {
      window.dispatchEvent(
        new CustomEvent("oneflowe:context-changed", { detail: { organizationId: id, branchId: null } }),
      )
    } catch {}
  }, [])

  const setBranch = useCallback((id: string | null) => {
    setBranchId(id)
    setVersion((v) => v + 1)
    try {
      window.dispatchEvent(new CustomEvent("oneflowe:context-changed", { detail: { branchId: id } }))
    } catch {}
  }, [])

  const reset = useCallback(() => {
    setOrganizationId(null)
    setBranchId(null)
    setVersion((v) => v + 1)
    try {
      window.dispatchEvent(new Event("oneflowe:context-reset"))
    } catch {}
  }, [])

  const level: OrgBranchContextValue["level"] = useMemo(() => {
    if (branchId) return "BRANCH"
    if (organizationId) return "ORGANIZATION"
    return "NONE"
  }, [organizationId, branchId])

  const canManageOrganization = role === "SUPER_ADMIN" || role === "HEAD_OFFICE"
  const canManageBranch = role === "SUPER_ADMIN" || role === "HEAD_OFFICE" || role === "BRANCH_ADMIN"

  const value = useMemo(
    () => ({
      organizationId,
      branchId,
      setOrganization,
      setBranch,
      reset,
      level,
      role,
      setRole,
      canManageOrganization,
      canManageBranch,
      version,
    }),
    [
      organizationId,
      branchId,
      setOrganization,
      setBranch,
      reset,
      level,
      role,
      canManageOrganization,
      canManageBranch,
      version,
    ],
  )

  return <OrgBranchContext.Provider value={value}>{children}</OrgBranchContext.Provider>
}

export function useOrgBranch() {
  const ctx = useContext(OrgBranchContext)
  if (!ctx) throw new Error("useOrgBranch must be used within OrgBranchProvider")
  return ctx
}

export const useOrgBranchContext = useOrgBranch
