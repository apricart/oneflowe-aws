"use client"

import { useMemo } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"

export type SalesSeriesPoint = {
    label: string
    sales: number
    netSales?: number
    orders: number
    itemQuantity?: number
}

export type BranchSalesPoint = {
    branchId: number
    branchName: string
    sales: number
    orders: number
}

export type SalesPerformanceResponse = {
    granularity: "hourly" | "daily" | "monthly" | "yearly"
    seriesData: SalesSeriesPoint[]
    totalSales: number
    totalNetSales?: number
    totalOrders: number
    totalItemsSold?: number
    avgSales: number
    avgItemsSold?: number
    peakPeriod: { label: string; sales: number; orders: number; itemQuantity?: number } | null
    peakQuantityPeriod?: { label: string; sales: number; orders: number; itemQuantity?: number } | null
    branchSales: BranchSalesPoint[]
    organizationSales?: { organizationId: number; organizationName: string; sales: number; orders: number }[]
    comparison?: {
        totalSales: number
        totalNetSales?: number
        totalOrders: number
        totalItemsSold?: number
        fulfilledCount?: number
        fulfilledNetSales?: number
        refundedCount?: number
        rejectedCount?: number
        approvedCount?: number
        pendingCount?: number
        deliveredCount?: number
        notDeliveredCount?: number
        partialCount?: number
        seriesData?: SalesSeriesPoint[]
    } | null
    statusCounts?: {
        pendingCount: number
        approvedCount: number
        fulfilledCount: number
        partialCount: number
        refundedCount: number
        rejectedCount: number
        deliveredCount: number
        notDeliveredCount: number
    } | null
}

export type DateRange = {
    startDate: Date
    endDate: Date
}

export type DashboardStatus = "all" | "PENDING" | "FULFILLED" | "REFUNDED" | "REJECTED" | "APPROVED" | "PARTIAL" | "DELIVERED" | "NOT_DELIVERED"

const normalizeMonthsForApi = (selectedMonths?: number[]) => {
    if (!selectedMonths || selectedMonths.length === 0) return []

    const isLegacyZeroBased = selectedMonths.includes(0)
    const normalized = selectedMonths
        .map(month => isLegacyZeroBased ? month + 1 : month)
        .filter(month => Number.isInteger(month) && month >= 1 && month <= 12)

    return Array.from(new Set(normalized)).sort((a, b) => a - b)
}

export interface SalesPerformanceOptions {
    organizationId?: string | null
    branchId?: string | null
    branchIds?: string[]
    groupId?: string | null
    dateRange?: DateRange | null
    status?: DashboardStatus
    compare?: boolean
    compareRange?: DateRange | null
    months?: number[]
    years?: number[]
    compareMonths?: number[]
    compareYears?: number[]
    granularity?: "hourly" | "daily" | "monthly" | "yearly"
    organizationIds?: string[]
    includeStatusCounts?: boolean
    request?: {
        // Pass false to defer fetching (e.g. until org/branch context has
        // hydrated) — prevents a throwaway request with the wrong scope.
        enabled?: boolean
        // Keep showing the previous result while a new key (filter change)
        // is being fetched, instead of resetting data to undefined.
        keepPreviousData?: boolean
    }
}

const hasValues = <T,>(values?: T[]) => Boolean(values?.length)

const addScopeParams = (params: URLSearchParams, options: SalesPerformanceOptions) => {
    const { organizationIds, organizationId, branchIds, branchId, groupId } = options
    if (hasValues(organizationIds)) {
        params.set("organizationIds", organizationIds!.join(","))
    } else if (organizationId && organizationId !== "null" && organizationId !== "0") {
        params.set("organizationId", organizationId)
    }

    if (hasValues(branchIds)) {
        params.set("branchIds", branchIds!.join(","))
    } else if (branchId && branchId !== "null" && branchId !== "0") {
        params.set("branchId", branchId)
    }

    if (groupId && groupId !== "all") params.set("groupId", groupId)
}

const addDateParams = (params: URLSearchParams, options: SalesPerformanceOptions) => {
    const { dateRange, months, years } = options
    const hasMonthOrYearSelection = hasValues(months) || hasValues(years)
    if (dateRange && !hasMonthOrYearSelection) {
        params.set("startDate", dateRange.startDate.toISOString())
        params.set("endDate", dateRange.endDate.toISOString())
        return
    }
    if (hasMonthOrYearSelection) return

    const today = new Date()
    const start = new Date(today)
    const end = new Date(today)
    start.setHours(0, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
    params.set("startDate", start.toISOString())
    params.set("endDate", end.toISOString())
}

const addPeriodSelections = (params: URLSearchParams, options: SalesPerformanceOptions) => {
    const apiMonths = normalizeMonthsForApi(options.months)
    if (apiMonths.length > 0) params.set("months", apiMonths.join(","))
    if (hasValues(options.years)) params.set("years", options.years!.join(","))
}

const addComparisonParams = (params: URLSearchParams, options: SalesPerformanceOptions) => {
    if (!options.compare) return

    params.set("compare", "true")
    if (options.compareRange) {
        params.set("compareStartDate", options.compareRange.startDate.toISOString())
        params.set("compareEndDate", options.compareRange.endDate.toISOString())
    }
    const apiCompareMonths = normalizeMonthsForApi(options.compareMonths)
    if (apiCompareMonths.length > 0) params.set("compareMonths", apiCompareMonths.join(","))
    if (hasValues(options.compareYears)) params.set("compareYears", options.compareYears!.join(","))
}

const buildSalesPerformanceUrl = (options: SalesPerformanceOptions) => {
    const params = new URLSearchParams()
    if (options.granularity) params.set("granularity", options.granularity)
    addScopeParams(params, options)
    addDateParams(params, options)
    addPeriodSelections(params, options)
    if (options.status && options.status !== "all") params.set("status", options.status)
    addComparisonParams(params, options)
    if (options.includeStatusCounts && (!options.status || options.status === "all")) {
        params.set("includeStatusCounts", "true")
    }
    return `/api/v1/analytics/sales-performance?${params.toString()}`
}

export function useSalesPerformance({
    organizationId,
    branchId,
    branchIds,
    groupId,
    dateRange,
    status,
    compare,
    compareRange,
    months,
    years,
    compareMonths,
    compareYears,
    granularity,
    organizationIds,
    includeStatusCounts,
    request,
}: SalesPerformanceOptions = {}) {
    const url = useMemo(
        () => buildSalesPerformanceUrl({
            organizationId, branchId, branchIds, groupId, dateRange, status, compare,
            compareRange, months, years, compareMonths, compareYears, granularity,
            organizationIds, includeStatusCounts,
        }),
        [organizationId, branchId, branchIds, groupId, dateRange, status, compare, compareRange, months, years, compareMonths, compareYears, granularity, organizationIds, includeStatusCounts],
    )

    return useSWR<SalesPerformanceResponse>(request?.enabled === false ? null : url, fetcher, {
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        refreshInterval: 120_000, // 2 minutes
        keepPreviousData: request?.keepPreviousData === true,
    })
}

// Convenience hook for the lifetime stats using status filter
export function useDashboardKPIs(options: Omit<SalesPerformanceOptions, "includeStatusCounts" | "request"> = {}) {
    return useSalesPerformance(options)
}
