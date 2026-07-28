"use client"

import { useState } from "react"
import { Building2, GitBranch, RotateCcw, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { Check } from "lucide-react"
import { useAppContext } from "@/components/context/app-context"
import useSWR from "swr"
import { cn } from "@/lib/utils"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

export function ContextSelector() {
  const {
    organizationId,
    branchId,
    branchIds,
    userRole,
    userOrgId,
    userBranchId,
    setOrganizationId,
    setBranchId,
    resetContext,
    isInitialized,
  } = useAppContext()

  const [orgOpen, setOrgOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)

  // Fetch organizations
  const { data: orgsData, isLoading: orgsLoading } = useSWR(
    "/api/v1/organizations",
    fetcher
  )

  // Read-only roles should always use their assigned scope, even while the
  // client context is being restored after a full page load.
  const scopedOrganizationId =
    userRole === "BRANCH_ADMIN" && userOrgId
      ? String(userOrgId)
      : organizationId
  const scopedBranchId =
    userRole === "BRANCH_ADMIN" && userBranchId
      ? String(userBranchId)
      : branchId

  // Fetch branches (filtered by selected organization)
  const { data: branchesData, isLoading: branchesLoading } = useSWR(
    scopedOrganizationId ? `/api/v1/branches?organizationId=${scopedOrganizationId}` : null,
    fetcher
  )

  const organizations = (orgsData?.items || []).filter((org: any) => org.status === "active")
  const branches = (branchesData?.items || []).filter((branch: any) => branch.status === "active")
  const listedBranch = branches.find((branch: any) => branch.id.toString() === scopedBranchId)

  // The collection request can be unavailable during a route reload. Resolve
  // the assigned branch directly so its real name still reaches the breadcrumb.
  const { data: assignedBranchData, isLoading: assignedBranchLoading } = useSWR(
    userRole === "BRANCH_ADMIN" && scopedBranchId && !branchesLoading && !listedBranch
      ? `/api/v1/branches/${scopedBranchId}`
      : null,
    fetcher
  )

  // Don't render until initialized
  if (!isInitialized) return null

  // Branch Admin & Head Office: show read-only breadcrumb
  if (userRole === "BRANCH_ADMIN" || userRole === "HEAD_OFFICE") {
    const org = organizations.find((o: any) => o.id.toString() === scopedOrganizationId)
    const branch = listedBranch || assignedBranchData?.item

    // Handle label for HO with multiple branches
    let branchLabel: string
    if (userRole === "BRANCH_ADMIN") {
      branchLabel = branch?.name
        || (branchesLoading || assignedBranchLoading ? "Loading branch..." : "Assigned Branch")
    } else {
      branchLabel = "Global Overview"
      if (branchIds.length > 1) {
        branchLabel = `${branchIds.length} Branches`
      } else if (branch) {
        branchLabel = branch.name
      } else if (branchIds.length === 1) {
        const singleBranch = branches.find((b: any) => b.id.toString() === branchIds[0])
        branchLabel = singleBranch?.name || "1 Branch"
      }
    }

    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border bg-muted/50 text-xs animate-in fade-in duration-300">
        {org && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Building2 className="h-4 w-4 text-blue-600" />
            <span className="font-bold text-slate-700 dark:text-slate-200">{org.name}</span>
          </div>
        )}
        {org && (
          <span className="text-slate-400 font-medium mx-1">/</span>
        )}
        <div className="flex items-center gap-1.5 overflow-hidden">
          <GitBranch className={`h-4 w-4 ${(branch || branchIds.length > 0) ? "text-indigo-600" : "text-slate-400"}`} />
          <span className={`font-semibold truncate ${(branch || branchIds.length > 0) ? "text-slate-700 dark:text-slate-200" : "text-slate-500 italic"}`}>
            {branchLabel}
          </span>
        </div>
      </div>
    )
  }

  // Super Admin: show interactable selectors
  const selectedOrg = organizations.find((o: any) => o.id.toString() === organizationId)
  const selectedBranch = branches.find((b: any) => b.id.toString() === branchId)

  return (
    <div className="flex items-center gap-3">
      {/* Organization Selector - Searchable Popover */}
      <div className="flex items-center gap-2">
        <div className="relative">
          <Popover open={orgOpen} onOpenChange={setOrgOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={orgOpen}
                className={cn(
                  "w-[220px] justify-between px-3.5 h-10 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-bold text-xs shadow-sm hover:bg-slate-50 dark:hover:bg-slate-900 transition-all focus-within:ring-2 focus-within:ring-indigo-500/20",
                  !organizationId && "text-slate-400"
                )}
              >
                <div className="flex items-center gap-2.5 truncate mr-2">
                    <Building2 className={cn("h-4 w-4 shrink-0", organizationId ? "text-blue-600" : "text-slate-400")} />
                    <span className="truncate">
                      {orgsLoading ? "Loading..." : selectedOrg?.name || "All Organizations"}
                    </span>
                </div>
                <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 opacity-50 transition-transform duration-200", orgOpen && "rotate-180")} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[220px] p-0 rounded-2xl border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden" align="start">
              <Command className="bg-white dark:bg-slate-950">
                <CommandInput placeholder="Search organization..." className="h-10 text-xs font-bold" />
                <CommandList className="max-h-[300px]">
                  <CommandEmpty className="py-4 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest italic">No organization found.</CommandEmpty>
                  <CommandGroup className="p-1.5">
                    <CommandItem
                      value="all"
                      onSelect={() => {
                        setOrganizationId(null)
                        setOrgOpen(false)
                      }}
                      className="flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-bold uppercase tracking-tight cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Check className={cn("h-3.5 w-3.5 text-indigo-600", !organizationId ? "opacity-100" : "opacity-0")} />
                        <span>All Organizations</span>
                      </div>
                    </CommandItem>
                    {organizations.map((org: any) => (
                      <CommandItem
                        key={org.id}
                        value={org.name}
                        onSelect={() => {
                          setOrganizationId(org.id.toString())
                          setOrgOpen(false)
                        }}
                        className="flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-bold uppercase tracking-tight cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <Check className={cn("h-3.5 w-3.5 text-indigo-600", organizationId === org.id.toString() ? "opacity-100" : "opacity-0")} />
                          <span>{org.name}</span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Branch Selector - Searchable Popover */}
      <div className="flex items-center gap-2">
        <div className="relative">
          <Popover open={branchOpen} onOpenChange={setBranchOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={branchOpen}
                disabled={!organizationId}
                className={cn(
                  "w-[220px] justify-between px-3.5 h-10 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-bold text-xs shadow-sm hover:bg-slate-50 dark:hover:bg-slate-900 transition-all focus-within:ring-2 focus-within:ring-indigo-500/20",
                  !branchId && "text-slate-400",
                  !organizationId && "opacity-60 cursor-not-allowed bg-slate-50 dark:bg-slate-900 border-dashed"
                )}
              >
                <div className="flex items-center gap-2.5 truncate mr-2">
                    <GitBranch className={cn("h-4 w-4 shrink-0", branchId ? "text-indigo-600" : "text-slate-400")} />
                    <span className="truncate">
                      {branchesLoading
                        ? "Loading..."
                        : !organizationId
                          ? "Select Organization"
                          : selectedBranch?.name || "All Branches"}
                    </span>
                </div>
                <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 opacity-50 transition-transform duration-200", branchOpen && "rotate-180")} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[220px] p-0 rounded-2xl border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden" align="start">
              <Command className="bg-white dark:bg-slate-950">
                <CommandInput placeholder="Search branch..." className="h-10 text-xs font-bold" />
                <CommandList className="max-h-[300px]">
                  <CommandEmpty className="py-4 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest italic">No branch found.</CommandEmpty>
                  <CommandGroup className="p-1.5">
                    <CommandItem
                      value="all"
                      onSelect={() => {
                        setBranchId(null)
                        setBranchOpen(false)
                      }}
                      className="flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-bold uppercase tracking-tight cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Check className={cn("h-3.5 w-3.5 text-indigo-600", !branchId ? "opacity-100" : "opacity-0")} />
                        <span>All Branches</span>
                      </div>
                    </CommandItem>
                    {branches.map((branch: any) => (
                      <CommandItem
                        key={branch.id}
                        value={branch.name}
                        onSelect={() => {
                          setBranchId(branch.id.toString())
                          setBranchOpen(false)
                        }}
                        className="flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-bold uppercase tracking-tight cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <Check className={cn("h-3.5 w-3.5 text-indigo-600", branchId === branch.id.toString() ? "opacity-100" : "opacity-0")} />
                          <span>{branch.name}</span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Reset Button */}
      {(organizationId || branchId) && (
        <Button
          variant="ghost"
          size="icon"
          onClick={resetContext}
          title="Reset to global scope"
          className="rounded-full hover:bg-indigo-50 dark:hover:bg-indigo-900/10 text-slate-400 hover:text-indigo-600 transition-all"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

