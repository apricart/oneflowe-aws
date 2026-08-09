"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useSession } from "next-auth/react"
import { useAppContext } from "@/components/context/app-context"
import { useAPI } from "@/lib/hooks/use-api"
import { getPendingOrderReviewHref } from "@/lib/order-status"

export type NotificationSeverity = "info" | "warning" | "critical"

export type DashboardNotification = {
  id: string
  type?: string
  title: string
  message: string
  severity: NotificationSeverity
  cta?: {
    label: string
    href: string
  }
  tag?: string
}

type ApiNotificationsResponse = {
  items: DashboardNotification[]
}

type PendingRefundsResponse = {
  refunds?: Array<{
    id: number
    amountCents?: number | null
    tid?: string | null
    branchName?: string | null
  }>
}

type PendingOrdersResponse = {
  items: any[]
  capabilities?: {
    canApproveOrders: boolean
    canRejectOrders: boolean
  }
}

const getNotificationReadKey = (notification: DashboardNotification) =>
  [
    notification.id,
    notification.severity,
    notification.tag || "",
    notification.title,
    notification.message,
  ].join("|")

export function useDashboardNotifications() {
  const { data: session, status: sessionStatus } = useSession()
  const role = (session?.user as any)?.role as "SUPER_ADMIN" | "HEAD_OFFICE" | "BRANCH_ADMIN" | "ORDER_PORTAL" | undefined
  const userId = (session?.user as any)?.id || session?.user?.email || "anonymous"
  const { organizationId, branchId, isInitialized } = useAppContext()
  const [seenNotificationKeys, setSeenNotificationKeys] = useState<Set<string>>(new Set())

  const scopedOrgId = role === "SUPER_ADMIN" ? undefined : organizationId || undefined
  const scopedBranchId = role === "BRANCH_ADMIN" ? branchId || undefined : undefined
  const isAdminRole = role === "SUPER_ADMIN" || role === "HEAD_OFFICE" || role === "BRANCH_ADMIN"
  const seenStorageKey = useMemo(
    () => [
      "oneflowe.dashboard-notifications.seen",
      userId,
      role,
      organizationId ?? "all-orgs",
      branchId ?? "all-branches",
    ].join(":"),
    [userId, role, organizationId, branchId],
  )

  useEffect(() => {
    if (typeof window === "undefined") return

    try {
      const stored = window.localStorage.getItem(seenStorageKey)
      const parsed = stored ? JSON.parse(stored) : []
      setSeenNotificationKeys(new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []))
    } catch {
      setSeenNotificationKeys(new Set())
    }
  }, [seenStorageKey])

  const pendingOrdersUrl = useMemo(() => {
    if (!isAdminRole) return null
    const params = new URLSearchParams({ status: "pending" })
    if (scopedOrgId) params.set("organizationId", scopedOrgId)
    if (scopedBranchId) params.set("branchId", scopedBranchId)
    return `/api/v1/orders?${params.toString()}`
  }, [isAdminRole, scopedOrgId, scopedBranchId])
  const branchesUrl = role === "HEAD_OFFICE"
    ? `/api/v1/branches${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ""}`
    : null
  const usersUrl = role === "HEAD_OFFICE"
    ? `/api/v1/users${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ""}`
    : null

  const pendingOrdersQuery = useAPI<PendingOrdersResponse>(pendingOrdersUrl)
  const branchesQuery = useAPI<{ items: any[] }>(branchesUrl)
  const usersQuery = useAPI<{ items: any[] }>(usersUrl)
  const dbNotificationsQuery = useAPI<ApiNotificationsResponse>(session?.user ? "/api/v1/notifications" : null, {
    refreshInterval: 30000,
    errorRetryCount: 1,
  })
  const pendingRefundsQuery = useAPI<PendingRefundsResponse>(
    role === "SUPER_ADMIN" ? "/api/v1/admin/refunds?status=pending" : null,
    {
      refreshInterval: 30000,
      errorRetryCount: 1,
    },
  )

  const computedNotifications = useMemo<DashboardNotification[]>(() => {
    if (!isInitialized || !isAdminRole) return []
    const items: DashboardNotification[] = []
    const pendingOrders = pendingOrdersQuery.data?.items || []
    if (pendingOrdersQuery.data?.capabilities?.canApproveOrders && pendingOrders.length > 0) {
      const severity = pendingOrders.length > 10 ? "critical" : "warning"
      const isSinglePendingOrder = pendingOrders.length === 1
      items.push({
        id: "pending-orders",
        title: "Orders awaiting approval",
        message:
          isSinglePendingOrder
            ? "1 order has been waiting for approval."
            : `${pendingOrders.length} orders require approval.`,
        severity,
        cta: {
          label: isSinglePendingOrder ? "Review order" : "Review orders",
          href: getPendingOrderReviewHref(pendingOrders[0]?.id, pendingOrders.length),
        },
        tag: pendingOrders[0]?.status || "pending",
      })
    }

    if (role === "SUPER_ADMIN") {
      const pendingRefunds = pendingRefundsQuery.data?.refunds || []
      if (pendingRefunds.length > 0) {
        const latest = pendingRefunds[0]
        const amountLabel =
          typeof latest?.amountCents === "number"
            ? `PKR ${(latest.amountCents / 100).toFixed(2)}`
            : "amount unavailable"
        const targetLabel = latest?.tid ? `Transaction ID ${latest.tid}` : "unknown transaction"
        const branchLabel = latest?.branchName ? ` from ${latest.branchName}` : ""

        items.push({
          id: "pending-refunds",
          title: `${pendingRefunds.length} refund request${pendingRefunds.length === 1 ? "" : "s"} awaiting review`,
          message: `Latest request: ${targetLabel} — ${amountLabel}${branchLabel}.`,
          severity: pendingRefunds.length > 5 ? "critical" : "warning",
          cta: { label: "Review refunds", href: "/refunds" },
          tag: `${pendingRefunds.length} pending`,
        })
      }
    }



    if (role === "HEAD_OFFICE") {
      const branches = (branchesQuery.data?.items || []) as Array<{
        id: number
        status?: string | null
      }>
      const users = (usersQuery.data?.items || []) as Array<{
        role?: string
        branchId?: number | null
      }>
      const adminsByBranch = new Set(
        users.filter((u) => u.role === "BRANCH_ADMIN" && typeof u.branchId === "number").map((u) => String(u.branchId)),
      )

      const inactiveBranches = branches.filter((b) => (b.status || "inactive").toLowerCase() !== "active")
      if (inactiveBranches.length > 0) {
        items.push({
          id: "inactive-branches",
          title: "Branches offline",
          message: `${inactiveBranches.length} branch${inactiveBranches.length === 1 ? " is" : "es are"
            } marked inactive.`,
          severity: "warning",
          cta: { label: "View branches", href: "/branches" },
          tag: "ops",
        })
      }
    }


    return items
  }, [
    isInitialized,
    isAdminRole,
    role,
    branchesQuery.data?.items,
    pendingRefundsQuery.data?.refunds,
    pendingOrdersQuery.data?.items,
    pendingOrdersQuery.data?.capabilities?.canApproveOrders,
    usersQuery.data?.items,
  ])

  const rawDbNotifications = useMemo(
    () => dbNotificationsQuery.data?.items || [],
    [dbNotificationsQuery.data?.items],
  )

  const dbNotifications = useMemo(
    () =>
      role === "SUPER_ADMIN"
        ? rawDbNotifications.filter((notification) => notification.type !== "REFUND_REQUESTED")
        : rawDbNotifications,
    [rawDbNotifications, role],
  )

  const notifications = useMemo<DashboardNotification[]>(
    () => [...dbNotifications, ...computedNotifications],
    [computedNotifications, dbNotifications],
  )

  const isLoading =
    sessionStatus === "loading" ||
    !isInitialized ||
    pendingOrdersQuery.isLoading ||
    branchesQuery.isLoading ||
    usersQuery.isLoading ||
    dbNotificationsQuery.isLoading ||
    pendingRefundsQuery.isLoading

  const unreadNotifications = useMemo(
    () => notifications.filter((notification) => !seenNotificationKeys.has(getNotificationReadKey(notification))),
    [notifications, seenNotificationKeys],
  )

  const markAllAsRead = useCallback(() => {
    if (typeof window === "undefined" || notifications.length === 0) return

    setSeenNotificationKeys((currentKeys) => {
      const nextKeys = new Set(currentKeys)
      notifications.forEach((notification) => {
        nextKeys.add(getNotificationReadKey(notification))
      })

      const serializedKeys = Array.from(nextKeys).slice(-200)
      try {
        window.localStorage.setItem(seenStorageKey, JSON.stringify(serializedKeys))
      } catch {
        // Keep the in-memory read state even if browser storage is unavailable.
      }
      return new Set(serializedKeys)
    })

    if (rawDbNotifications.length > 0) {
      void fetch("/api/v1/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark-all-read" }),
      }).catch(() => {
        // Keep the existing local read state if the server update fails.
      })
    }
  }, [notifications, rawDbNotifications.length, seenStorageKey])

  const criticalCount = unreadNotifications.filter((n) => n.severity !== "info").length

  return {
    role,
    notifications,
    unreadCount: unreadNotifications.length,
    criticalCount,
    isLoading,
    markAllAsRead,
  }
}

