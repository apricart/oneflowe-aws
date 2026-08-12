import { AppContextProvider } from "@/components/context/app-context"
import { SessionGuard } from "@/components/shell/session-guard"

export const metadata = {
  title: "Order Portal - Apricart OneFlowe",
  description: "Employee Order Portal",
  icons: {
    icon: '/logo-web.png',
    shortcut: '/logo-web.png',
    apple: '/logo-web.png',
  },
}

export default function ShopLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <AppContextProvider>
      <SessionGuard>
        {children}
      </SessionGuard>
    </AppContextProvider>
  )
}
