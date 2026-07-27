"use client"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { signOut, useSession } from "next-auth/react"
import Image from "next/image"
import { Moon, Sun, BarChart3 } from "lucide-react"
import { useTheme } from "next-themes"
import { CommandPalette } from "@/components/ui/command-palette"
import { ContextSelector } from "@/components/shell/context-selector"
import Link from "next/link"
import { NotificationBell } from "@/components/notifications/notification-center"
import { MultiBranchFilter } from "@/components/dashboard/multi-branch-filter"
import { useAppContext } from "@/components/context/app-context"
import { MANUAL_SIGN_OUT_EVENT } from "@/components/shell/session-guard"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LogOut, Settings as SettingsIcon } from "lucide-react"

export function Topbar() {
  const { data: session } = useSession()
  const [mounted, setMounted] = useState(false)
  const { theme, setTheme } = useTheme()
  const { organizationId, branchIds, setBranchIds, userRole } = useAppContext()

  useEffect(() => {
    setMounted(true)
  }, [])

  async function logout() {
    try {
      localStorage.removeItem('theme')
      localStorage.removeItem('ctx.organizationId')
      localStorage.removeItem('ctx.branchId')
      window.dispatchEvent(new Event(MANUAL_SIGN_OUT_EVENT))
      
      // Explicitly sign out and redirect to main login
      await signOut({ 
        redirect: true,
        callbackUrl: "/login"
      })
    } catch (_) {
      // Ensure redirect happens even if signOut fails
      window.location.replace("/login")
    }
  }


  return (
    <header
      className="sticky top-0 z-40 w-full h-14 flex items-center justify-between px-4 border-b border-slate-200 dark:border-slate-800 backdrop-blur supports-[backdrop-filter]:bg-background/80 dark:supports-[backdrop-filter]:bg-slate-950/80 bg-white dark:bg-slate-950"
    >
      <div className="flex items-center gap-3">
        <div className="hidden lg:flex">
          <ContextSelector />
        </div>
        
        {/* Global Branch Filter for HEAD_OFFICE */}
        {userRole === "HEAD_OFFICE" && organizationId && (
          <div className="hidden lg:flex">
            <MultiBranchFilter
              organizationId={organizationId}
              selectedBranchIds={branchIds}
              onChange={setBranchIds}
            />
          </div>
        )}
      </div>

      {/* Right Side - Actions & Profile */}
      <div className="flex items-center gap-3">

        {/* Group Analytics link */}
        {(userRole === "SUPER_ADMIN" || userRole === "HEAD_OFFICE") && (
          <Link href="/groups/analytics">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 hidden sm:flex border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
            >
              <BarChart3 className="h-4 w-4" />
              Group Analytics
            </Button>
          </Link>
        )}
        {/* Notifications */}
        <NotificationBell />

        {/* Theme Toggle */}
        {mounted ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              let resolvedTheme = theme
              if (theme === "system" || !theme) {
                resolvedTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
              }
              const newTheme = resolvedTheme === "dark" ? "light" : "dark"
              setTheme(newTheme)
            }}
            className="relative"
            aria-label="Toggle theme"
            title={mounted && theme ? `Current: ${theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}` : "Toggle theme"}
          >
            <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">Toggle theme</span>
          </Button>
        ) : (
          <div className="h-10 w-10" />
        )}

        {/* Profile Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex items-center gap-2 rounded-full px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none"
            >
              <Image
                src="/placeholder-user.jpg"
                alt="avatar"
                width={32}
                height={32}
                className="rounded-full ring-2 ring-slate-200 dark:ring-slate-700"
              />
              <span className="text-sm hidden md:inline font-medium text-slate-900 dark:text-white">
                {(session?.user as any)?.fullName || (session?.user as any)?.email?.split("@")[0] || "Account"}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 p-2">
            <DropdownMenuLabel className="px-3 py-2">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none text-slate-900 dark:text-white">
                  {(session?.user as any)?.fullName || "User"}
                </p>
                <p className="text-xs leading-none text-muted-foreground">
                  {(session?.user as any)?.email || "user@example.com"}
                </p>
                <p className="text-[10px] leading-none text-muted-foreground mt-1 capitalize font-normal bg-slate-100 dark:bg-slate-800 w-fit px-1.5 py-0.5 rounded">
                  {userRole?.toLowerCase().replace("_", " ")}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="mx-0 my-1" />
            <DropdownMenuItem
              onClick={() => (window.location.replace("/settings"))}
              className="gap-2 px-3 py-2 cursor-pointer"
            >
              <SettingsIcon className="h-4 w-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={logout}
              className="gap-2 px-3 py-2 cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-900/20"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
