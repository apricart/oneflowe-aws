import type { ReactElement } from "react"
import { render, type RenderResult } from "@testing-library/react"
import { SWRConfig } from "swr"

import { AppContextProvider } from "@/components/context/app-context"

export * from "./ui-mocks"

/** Render with a fresh SWR cache and the real application context provider. */
export function renderWithApp(node: ReactElement, options: { withAppContext?: boolean } = {}): RenderResult {
  const tree = (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false, errorRetryCount: 0 }}>
      {options.withAppContext === false ? node : <AppContextProvider>{node}</AppContextProvider>}
    </SWRConfig>
  )
  return render(tree)
}
