"use client"
import useSWR, { type SWRConfiguration, type SWRResponse } from "swr"
import { useAppContext } from "@/components/context/app-context"

export function useScopedSWR<Key extends string, Data = any, Error = any>(
  key: Key | null,
  fetcher: (url: string) => Promise<Data>,
  config?: SWRConfiguration<Data, Error>,
): SWRResponse<Data, Error> {
  const { organizationId, branchId } = useAppContext()
  const isInvalidKey = !key || key === "undefined" || key === "null"

  let requestUrl: string | null = null
  let cacheKey: string | null = null

  if (!isInvalidKey) {
    const url = new URL(
      key,
      typeof window !== "undefined" ? window.location.origin : "http://localhost",
    )
    if (organizationId) url.searchParams.set("organizationId", organizationId)
    if (branchId) url.searchParams.set("branchId", branchId)
    requestUrl = url.toString()
    cacheKey = `${requestUrl}_${organizationId}_${branchId}`
  }

  return useSWR(
    cacheKey,
    () => fetcher(requestUrl as string),
    {
      revalidateOnFocus: true,
      keepPreviousData: true,
      ...config,
    },
  )
}
