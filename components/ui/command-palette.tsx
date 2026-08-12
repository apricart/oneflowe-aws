"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command"
import {
  Home,
  Settings,
  Users,
  Package,
  BarChart3,Search
} from "lucide-react"
import useSWR from "swr"
import { useSession } from "next-auth/react"

export function CommandPalette() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  const { data: session } = useSession()
  const role = (session?.user as any)?.role || "BRANCH_ADMIN"
  const { data: orgsData } = useSWR("/api/v1/organizations")
  const { data: branchesData } = useSWR("/api/v1/branches")


  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((open) => !open)
      }
    }

    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  const runCommand = React.useCallback((command: () => void) => {
    setOpen(false)
    command()
  }, [])

  return (
    <>
      <button type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground border rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <Search className="h-4 w-4" />
        <span className="hidden md:inline">Search...</span>
        <kbd className="hidden md:inline pointer-events-none h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-xs font-medium opacity-100">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Quick Actions">
            <CommandItem
              onSelect={() => runCommand(() => router.push("/dashboard"))}
            >
              <Home className="mr-2 h-4 w-4" />
              <span>Go to Dashboard</span>
            </CommandItem>

            {role !== "BRANCH_ADMIN" && (
              <CommandItem
                onSelect={() => runCommand(() => router.push("/users"))}
              >
                <Users className="mr-2 h-4 w-4" />
                <span>Manage Users</span>
              </CommandItem>
            )}

            <CommandItem
              onSelect={() => runCommand(() =>
                router.push(role === "BRANCH_ADMIN" ? "/branch-inventory" : "/inventory")
              )}
            >
              <Package className="mr-2 h-4 w-4" />
              <span>View Inventory</span>
            </CommandItem>

            {role !== "BRANCH_ADMIN" && (
              <CommandItem
                onSelect={() => runCommand(() => router.push("/reports"))}
              >
                <BarChart3 className="mr-2 h-4 w-4" />
                <span>View Reports</span>
              </CommandItem>
            )}

            <CommandItem
              onSelect={() => runCommand(() => router.push("/settings"))}
            >
              <Settings className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </CommandItem>
          </CommandGroup>


        </CommandList>
      </CommandDialog>
    </>
  )
}

