"use client"

import Image from "next/image"
import Link from "next/link"
import { KeyRound, LogOut } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { securelySignOut } from "@/lib/session-coordination"

function displayRole(role: string | null | undefined): string {
  if (!role) return "Order Portal"
  return role.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function OrderPortalProfileMenu({
  name,
  email,
  role,
}: Readonly<{
  name: string
  email?: string | null
  role?: string | null
}>) {
  const logout = async () => {
    try {
      await securelySignOut({ callbackUrl: "/login" })
    } catch {
      window.alert("Logout could not be completed securely. Please retry.")
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open user profile menu"
          className="flex min-w-0 items-center gap-2 rounded-full px-1.5 py-1 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-slate-800"
        >
          <Image
            src="/placeholder-user.jpg"
            alt=""
            width={32}
            height={32}
            className="rounded-full ring-2 ring-slate-200 dark:ring-slate-700"
          />
          <span className="hidden max-w-32 truncate text-sm font-medium text-slate-900 md:inline dark:text-white">
            {name}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-2">
        <DropdownMenuLabel className="px-3 py-2">
          <div className="flex flex-col gap-1">
            <p className="truncate text-sm font-medium leading-none text-slate-900 dark:text-white">{name}</p>
            {email && <p className="truncate text-xs font-normal text-muted-foreground">{email}</p>}
            <p className="mt-1 w-fit rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground dark:bg-slate-800">
              {displayRole(role)}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="cursor-pointer gap-2 px-3 py-2">
          <Link href="/forgot-password">
            <KeyRound className="h-4 w-4" />
            Reset password
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => { void logout() }}
          className="cursor-pointer gap-2 px-3 py-2 text-red-600 focus:bg-red-50 focus:text-red-600 dark:text-red-400 dark:focus:bg-red-900/20"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
