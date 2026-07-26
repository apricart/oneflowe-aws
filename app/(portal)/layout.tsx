import type { ReactNode } from "react"
import { Sidebar } from "@/components/shell/sidebar"
import { Topbar } from "@/components/shell/topbar"
import { PreloadData } from "@/components/preload-data"
import { AppContextProvider } from "@/components/context/app-context"
import { OrgBranchProvider } from "@/components/context/org-branch-context"
import { Toaster } from "@/components/ui/toaster"
import { SessionGuard } from "@/components/shell/session-guard"

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <AppContextProvider>
      <OrgBranchProvider>
        <SessionGuard>
          <div className="min-h-svh w-full flex bg-background dark:bg-slate-950">
            <PreloadData />
            <Sidebar />
            <div className="min-w-0 flex-1 grid grid-rows-[auto_1fr] bg-background dark:bg-slate-950">
              <Topbar />
              <main className="min-w-0 p-4 bg-background dark:bg-slate-950">{children}</main>
            </div>
          </div>
          <Toaster />
        </SessionGuard>
      </OrgBranchProvider>
    </AppContextProvider>
  )
}
