"use client"

import { SWRConfig } from "swr"
import { fetcher } from "@/lib/fetcher"

export function SWRProvider({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <SWRConfig
            value={{
                fetcher: (url: string) => fetcher(url),
                revalidateOnFocus: false,
                dedupingInterval: 2000,
            }}
        >
            {children}
        </SWRConfig>
    )
}
