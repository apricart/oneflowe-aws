"use client"

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { prefetchData } from '@/lib/hooks/use-api'

// Preload critical data when component mounts
export function PreloadData() {
  const { data: session } = useSession()

  useEffect(() => {
    if (!session?.user) return

    const userRole = (session.user as any).role

    // Prefetch critical data in parallel based on role
    const preloadCritical = async () => {
      try {
        const canViewUsers = ["SUPER_ADMIN", "HEAD_OFFICE"].includes(userRole)
        const canViewRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"].includes(userRole)

        const commonPrefetch = [
          prefetchData.organizations(),
          ...(canViewUsers ? [prefetchData.users()] : []),
          ...(canViewRoles ? [prefetchData.roles()] : []),
          prefetchData.branches(),
          prefetchData.orders(),
        ]

        // Only SUPER_ADMIN and HEAD_OFFICE can access these
        if (userRole === 'SUPER_ADMIN' || userRole === 'HEAD_OFFICE') {
          await Promise.all([
            ...commonPrefetch,
            prefetchData.suppliers(),
            prefetchData.inventoryTx(),
          ])
        } else {
          // BRANCH_ADMIN and others get limited prefetch
          await Promise.all(commonPrefetch)
        }
      } catch (error) {
        console.warn('Failed to prefetch some data:', error)
      }
    }

    preloadCritical()
  }, [session])

  return null // This component doesn't render anything
}

// Preload data for specific routes
export function PreloadDashboardData() {
  const { data: session } = useSession()

  useEffect(() => {
    if (!session?.user) return

    const userRole = (session.user as any).role
    const canViewUsers = ["SUPER_ADMIN", "HEAD_OFFICE"].includes(userRole)
    const canViewRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"].includes(userRole)

    const preload = async () => {
      try {
        await Promise.all([
          prefetchData.organizations(),
          ...(canViewUsers ? [prefetchData.users()] : []),
          ...(canViewRoles ? [prefetchData.roles()] : []),
        ])
      } catch (error) {
        console.warn('Failed to prefetch dashboard data:', error)
      }
    }

    preload()
  }, [session])

  return null
}
