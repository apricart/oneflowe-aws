import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { AlertCircle } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { getSharedServerSession } from "@/lib/auth"
import { canAccessUserManagement } from "@/lib/user-management-access"

export default async function UsersLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  const session = await getSharedServerSession()

  if (!session?.user) {
    redirect("/login")
  }

  if (!canAccessUserManagement((session.user as any).role)) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
            <h1 className="text-xl font-semibold">Access denied</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You do not have permission to access user management.
            </p>
          </CardContent>
        </Card>
      </main>
    )
  }

  return children
}
