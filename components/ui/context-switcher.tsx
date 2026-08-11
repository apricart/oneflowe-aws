"use client"

import * as React from "react"
import { Check, ChevronsUpDown, Building2, GitBranch, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import useSWR from "swr"
import { useSession } from "next-auth/react"

type ContextType = "organization" | "branch"

interface ContextSwitcherProps {
  type: ContextType
  className?: string
  disabled?: boolean
  showResetButton?: boolean
}

export function ContextSwitcher({ type, className, disabled = false, showResetButton = false }: Readonly<ContextSwitcherProps>) {
  const { data: session } = useSession()
  const [open, setOpen] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string>("")

  const userRole = (session?.user as any)?.role
  const userOrgId = (session?.user as any)?.organizationId

  // For HEAD_OFFICE: organization is fixed, only branches can be switched
  // For BRANCH_ADMIN: both are fixed (context selector hidden)
  const isOrgFixed = type === "organization" && userRole === "HEAD_OFFICE"
  const isDisabled = disabled || isOrgFixed

  // For branches: get the organization ID from context storage
  const [orgIdForBranches, setOrgIdForBranches] = React.useState<string | null>(null)
  
  React.useEffect(() => {
    if (type === "branch" && typeof window !== "undefined") {
      // HEAD_OFFICE users should use their assigned org
      if (userRole === "HEAD_OFFICE" && userOrgId) {
        setOrgIdForBranches(String(userOrgId))
      } else {
        // Read the current organization from unified context
        try {
          const contextKey = "oneflowe:org-branch-context"
          const saved = localStorage.getItem(contextKey)
          if (saved) {
            const contextData = JSON.parse(saved)
            setOrgIdForBranches(contextData.organizationId || null)
          }
        } catch {}
      }
    }
  }, [type, userRole, userOrgId])
    
  const endpoint = (() => {
    if (type === "organization") {
      return "/api/v1/organizations"
    }
    return (orgIdForBranches ? `/api/v1/branches?organizationId=${orgIdForBranches}` : "/api/v1/branches")
  })()
  
  const { data, isLoading: isLoadingData } = useSWR(endpoint)
  const items = data?.items || []

  // Initialize with user's assigned context
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      // Use the unified context storage
      const contextKey = "oneflowe:org-branch-context"
      const savedContext = localStorage.getItem(contextKey)
      let contextData: { organizationId: string | null; branchId: string | null } = { organizationId: null, branchId: null }
      
      if (savedContext) {
        try {
          contextData = JSON.parse(savedContext)
        } catch {}
      }
      
      // For HEAD_OFFICE, use their assigned organizationId
      if (type === "organization" && userRole === "HEAD_OFFICE" && userOrgId) {
        const orgIdStr = String(userOrgId)
        setSelectedId(orgIdStr)
        contextData.organizationId = orgIdStr
        localStorage.setItem(contextKey, JSON.stringify(contextData))
        // Also set the old format for backward compatibility
        localStorage.setItem("ctx.organizationId", orgIdStr)
        // Dispatch event so other components know
        window.dispatchEvent(new CustomEvent("context-changed", { detail: { type, id: orgIdStr } }))
      } else if (type === "organization" && contextData.organizationId) {
        setSelectedId(contextData.organizationId)
      } else if (type === "branch" && contextData.branchId) {
        setSelectedId(contextData.branchId)
      }
    }
  }, [type, userRole, userOrgId])
  
  // Listen for external context changes
  React.useEffect(() => {
    const handleContextChange = (e: any) => {
      const { type: eventType, id } = e.detail
      if (eventType === type) {
        setSelectedId(id || "")
      }
      // If this is a branch selector and organization changed, update orgIdForBranches
      if (type === "branch" && eventType === "organization") {
        setOrgIdForBranches(id || null)
        // Clear selected branch when organization changes
        setSelectedId("")
      }
    }
    
    window.addEventListener("context-changed", handleContextChange as EventListener)
    return () => window.removeEventListener("context-changed", handleContextChange as EventListener)
  }, [type])

  const selectedItem = items.find((item: any) => item.id.toString() === selectedId)
  
  // Debug logging
  React.useEffect(() => {
    if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
      console.log(`[ContextSwitcher-${type}]`, {
        selectedId,
        selectedItem,
        itemsCount: items.length,
        userRole,
        userOrgId,
        isOrgFixed
      })
    }
  }, [type, selectedId, selectedItem, items.length, userRole, userOrgId, isOrgFixed])

  const handleSelect = (id: string) => {
    setSelectedId(id)
    setOpen(false)
    
    if (typeof window !== "undefined") {
      // Update unified context storage
      const contextKey = "oneflowe:org-branch-context"
      let contextData: { organizationId: string | null; branchId: string | null } = { organizationId: null, branchId: null }
      
      try {
        const saved = localStorage.getItem(contextKey)
        if (saved) contextData = JSON.parse(saved)
      } catch {}
      
      if (type === "organization") {
        contextData.organizationId = id
        contextData.branchId = null // Clear branch when organization changes
        localStorage.removeItem("ctx.branchId") // Backward compatibility
      } else {
        contextData.branchId = id
      }
      
      localStorage.setItem(contextKey, JSON.stringify(contextData))
      
      // Also set individual keys for backward compatibility
      const storageKey = type === "organization" ? "ctx.organizationId" : "ctx.branchId"
      localStorage.setItem(storageKey, id)
      
      // Dispatch custom event for context change
      window.dispatchEvent(new CustomEvent("context-changed", { detail: { type, id } }))
    }
  }

  const handleReset = () => {
    if (typeof window !== "undefined") {
      // Update unified context storage
      const contextKey = "oneflowe:org-branch-context"
      let contextData: { organizationId: string | null; branchId: string | null } = { organizationId: null, branchId: null }
      
      try {
        const saved = localStorage.getItem(contextKey)
        if (saved) contextData = JSON.parse(saved)
      } catch {}
      
      if (type === "organization") {
        contextData.organizationId = null
        contextData.branchId = null
        localStorage.removeItem("ctx.organizationId")
        localStorage.removeItem("ctx.branchId")
      } else {
        contextData.branchId = null
        localStorage.removeItem("ctx.branchId")
      }
      
      localStorage.setItem(contextKey, JSON.stringify(contextData))
      setSelectedId("")
      setOpen(false)
      window.dispatchEvent(new CustomEvent("context-changed", { detail: { type, id: null } }))
    }
  }

  return (
    <div className="flex items-center gap-1">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
            disabled={isDisabled}
            className={cn("justify-between min-w-[200px]", className, isOrgFixed && "opacity-70 cursor-not-allowed")}
        >
          <div className="flex items-center gap-2 truncate">
            {type === "organization" ? (
              <Building2 className="h-4 w-4 shrink-0" />
            ) : (
              <GitBranch className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">
                {selectedItem?.name || 
                  ((() => {
                    if (selectedId && isLoadingData) {
                      return "Loading..."
                    }
                    return (type === "organization" ? "All Organizations" : "All Branches")
                  })()
                  )
                }
            </span>
          </div>
            {!isOrgFixed && <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${type}...`} />
          <CommandList>
            <CommandEmpty>No {type} found.</CommandEmpty>
            <CommandGroup>
                {/* Show "All" option for Super Admin */}
                {userRole === "SUPER_ADMIN" && (
                  <CommandItem
                    value={`All ${type}s`}
                    onSelect={() => handleReset()}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        !selectedId ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="font-medium">All {type === "organization" ? "Organizations" : "Branches"}</span>
                  </CommandItem>
                )}
              {items.map((item: any) => (
                <CommandItem
                  key={item.id}
                  value={item.name}
                  onSelect={() => handleSelect(item.id.toString())}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selectedId === item.id.toString() ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex items-center justify-between flex-1">
                    <div className="flex flex-col">
                      <span className="font-medium">{item.name}</span>
                      {item.code && (
                        <span className="text-xs text-muted-foreground">{item.code}</span>
                      )}
                    </div>
                    {item.status && (
                      <Badge
                        variant={item.status === "active" ? "default" : "secondary"}
                        className="ml-2"
                      >
                        {item.status}
                      </Badge>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
      
      {/* Reset button for Super Admin */}
      {showResetButton && userRole === "SUPER_ADMIN" && selectedId && (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleReset}
          className="h-9 w-9"
          title="Reset to global scope"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

