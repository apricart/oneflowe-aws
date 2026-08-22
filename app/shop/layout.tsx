import { AppContextProvider } from "@/components/context/app-context"
import { SessionGuard } from "@/components/shell/session-guard"
import { redirect } from "next/navigation"
import { getProtectedPageSession } from "@/lib/server/page-session"
import { SessionUnavailable } from "@/components/shell/session-unavailable"

export const metadata = {
  title: "Order Portal - Apricart OneFlowe",
  description: "Employee Order Portal",
  icons: {
    icon: '/logo-web.png',
    shortcut: '/logo-web.png',
    apple: '/logo-web.png',
  },
}

export default async function ShopLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  return (
    <AppContextProvider>
      <SessionGuard>
        {children}
      </SessionGuard>
    </AppContextProvider>
  )
}
