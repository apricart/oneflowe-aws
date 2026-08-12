import useSWR, { preload } from 'swr'
import { fetcher } from '@/lib/fetcher'

// Generic API hook with SWR caching
export function useAPI<T>(url: string | null, options?: any) {
  return useSWR<T>(url, fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    dedupingInterval: 5000, // Prevent duplicate requests during mount storms
    keepPreviousData: true, // Show stale data while revalidating
    refreshInterval: 0, // No auto-polling by default
    errorRetryCount: 3,
    ...options,
  })
}

// Predefined hooks for common endpoints
export function useUsers(organizationId?: string) {
  const url = organizationId ? `/api/v1/users?organizationId=${organizationId}` : '/api/v1/users'
  return useAPI<{ items: any[] }>(url)
}

export function useOrganizations() {
  return useAPI<{ items: any[] }>('/api/v1/organizations')
}

export function useBranches(organizationId?: string, groupIds?: string) {
  const qs = new URLSearchParams()
  if (organizationId) qs.set('organizationId', organizationId)
  if (groupIds) qs.set('groupIds', groupIds)
  const url = `/api/v1/branches${qs.toString() ? ("?" + String(qs.toString())) : ''}`
  return useAPI<{ items: any[] }>(url)
}

export function useGlobalProducts(organizationId?: string, groupIds?: string) {
  const qs = new URLSearchParams()
  if (organizationId) qs.set('organizationId', organizationId)
  if (groupIds) qs.set('groupIds', groupIds)
  const url = `/api/v1/inventory/organization-products${qs.toString() ? ("?" + String(qs.toString())) : ''}`
  return useAPI<{ items: any[] }>(url)
}

export function useRoles() {
  return useAPI<{ data: any[] }>('/api/v1/roles')
}

// Prefetch functions for critical data
export const prefetchData = {
  async users() {
    const { fetcher } = await import('@/lib/fetcher')
    preload('/api/v1/users', fetcher)
  },

  async organizations() {
    const { fetcher } = await import('@/lib/fetcher')
    preload('/api/v1/organizations', fetcher)
  },

  async roles() {
    const { fetcher } = await import('@/lib/fetcher')
    preload('/api/v1/roles', fetcher)
  },

  async branches() {
    const { fetcher } = await import('@/lib/fetcher')
    preload('/api/v1/branches', fetcher)
  },

  async orders() {
    const { fetcher } = await import('@/lib/fetcher')
    preload('/api/v1/orders', fetcher)
  },

  async suppliers() {
    const { fetcher } = await import('@/lib/fetcher')
    preload('/api/v1/suppliers', fetcher)
  },

  async inventoryTx() {
    const { fetcher } = await import('@/lib/fetcher')
    preload('/api/v1/inventory/transactions', fetcher)
  },
}

export function useOrders(params?: { organizationId?: string; branchId?: string; status?: string }) {
  const qs = new URLSearchParams()
  let orgId = params?.organizationId
  let brId = params?.branchId
  if (!orgId && typeof window !== 'undefined') {
    const v = localStorage.getItem('ctx.organizationId')
    if (v) orgId = v
  }
  if (!brId && typeof window !== 'undefined') {
    const v = localStorage.getItem('ctx.branchId')
    if (v) brId = v
  }
  if (orgId) qs.set('organizationId', orgId)
  if (brId) qs.set('branchId', brId)
  if (params?.status) qs.set('status', params.status)
  const url = `/api/v1/orders${qs.toString() ? ("?" + String(qs.toString())) : ''}`
  return useAPI<{ items: any[] }>(url)
}

// Admin-specific hooks
export function useRolePermissions(roleId?: number) {
  const url = roleId ? `/api/v1/roles/permissions?roleId=${roleId}` : null
  return useAPI<{ data: any[] }>(url)
}

export function useOrganizationSettings(organizationId?: number) {
  const url = organizationId ? `/api/v1/settings?organizationId=${organizationId}` : null
  return useAPI<{ data: any[] }>(url)
}

export function useAuditLogs(params?: { limit?: number; entity?: string; action?: string }) {
  const qs = new URLSearchParams()
  if (params?.limit) qs.set('limit', params.limit.toString())
  if (params?.entity) qs.set('entity', params.entity)
  if (params?.action) qs.set('action', params.action)
  const url = `/api/v1/audit-logs${qs.toString() ? ("?" + String(qs.toString())) : ''}`
  return useAPI<{ data: any[] }>(url)
}