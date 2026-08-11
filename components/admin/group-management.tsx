"use client"

import { useState,useEffect } from "react"
import useSWR,{ mutate } from "swr"
import { Plus,Pencil,Trash2,Building,CheckCircle2,Users,AlertCircle,Eraser,Package,Loader2,Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PremiumConfirmDialog } from "@/components/premium/premium-confirm-dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppContext } from "@/components/context/app-context"
import { formatCountLabel } from "@/lib/count-label"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

interface Group {
    id: number
    organizationId: number
    name: string
    description: string
    status: string
    branchCount: number
    createdAt: string
    organizationName?: string
}

interface Organization {
    id: number
    name: string
}

interface Branch {
    id: number
    name: string
    organizationId: number
    groupId: number | null
    groupName?: string | null
}

export function GroupManagement({ role }: Readonly<{ role: string }>) {
    const { toast } = useToast()
    const { organizationId: globalOrgId } = useAppContext()
    const [isCreateOpen, setIsCreateOpen] = useState(false)
    const [isEditOpen, setIsEditOpen] = useState(false)
    const [isBranchOpen, setIsBranchOpen] = useState(false)
    const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)
    const [isDeleting, setIsDeleting] = useState<number | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isCreating, setIsCreating] = useState(false)
    const [isUpdating, setIsUpdating] = useState(false)
    const [isReleasing, setIsReleasing] = useState<number | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; id: number | null }>({ open: false, id: null })
    const [confirmRelease, setConfirmRelease] = useState<{ open: boolean; id: number | null }>({ open: false, id: null })
    // Product protection states
    const [branchProductCounts, setBranchProductCounts] = useState<Record<number, number>>({})
    const [isCleaning, setIsCleaning] = useState<number | null>(null)
    const [confirmClean, setConfirmClean] = useState<{ open: boolean; branchId: number | null; branchName: string }>({ open: false, branchId: null, branchName: "" })
    const [isLoadingCounts, setIsLoadingCounts] = useState(false)
    const [originalBranchIds, setOriginalBranchIds] = useState<number[]>([]) // branches in group when dialog opened
    const [totalGroupProducts, setTotalGroupProducts] = useState(0) // total unique products in the group

    // Form states
    const [name, setName] = useState("")
    const [description, setDescription] = useState("")
    const [organizationId, setOrganizationId] = useState<string>("")
    const [selectedBranchIds, setSelectedBranchIds] = useState<number[]>([])
    const [branchSearch, setBranchSearch] = useState("")

    // Auto-select organization from global context when opening create dialog
    useEffect(() => {
        if (isCreateOpen && globalOrgId) {
            setOrganizationId(globalOrgId)
        }
    }, [isCreateOpen, globalOrgId])

    // Data fetching

    const groupsUrl = globalOrgId
        ? `/api/v1/groups?organizationId=${globalOrgId}`
        : "/api/v1/groups"

    const { data: groupsData, error: groupsError } = useSWR(groupsUrl, fetcher, {
        revalidateOnFocus: true,
        revalidateOnMount: true,
        dedupingInterval: 2000,
    })
    const { data: orgsData } = useSWR(role === "SUPER_ADMIN" ? "/api/v1/organizations" : null, fetcher)
    const currentOrg = orgsData?.items?.find((org: Organization) => org.id.toString() === globalOrgId)

    const branchesUrl = (selectedGroup?.organizationId || globalOrgId)
        ? `/api/v1/branches?organizationId=${selectedGroup?.organizationId || globalOrgId}`
        : null
    const { data: branchesData, mutate: mutateBranches } = useSWR(
        branchesUrl,
        fetcher,
        { revalidateOnFocus: true, dedupingInterval: 2000 }
    )

    const handleCreate = async () => {
        try {
            if (!name || !organizationId) {
                toast({ title: "Error", description: "Name and Organization are required", variant: "destructive" })
                return
            }

            setIsCreating(true)
            const res = await fetch("/api/v1/groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, description, organizationId: Number.parseInt(organizationId) }),
            })

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({ error: "Failed to create group" }))
                console.error("Group creation failed:", errorData)
                throw new Error(errorData.error || "Failed to create group")
            }

            toast({
                title: "Success",
                description: "Group created successfully",
                variant: "success"
            })
            setIsCreateOpen(false)
            setName("")
            setDescription("")
            setOrganizationId("")
            mutate(groupsUrl)
        } catch (e: any) {
            toast({ title: "Error", description: e.message, variant: "destructive" })
        } finally {
            setIsCreating(false)
        }
    }

    const handleUpdate = async () => {
        try {
            if (!selectedGroup) return
            setIsUpdating(true)

            const res = await fetch(`/api/v1/groups/${selectedGroup.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, description }),
            })

            if (!res.ok) throw new Error(await res.text())

            toast({
                title: "Success",
                description: "Group updated successfully",
                variant: "success"
            })
            setIsEditOpen(false)
            mutate(groupsUrl)
        } catch (e: any) {
            toast({ title: "Error", description: e.message, variant: "destructive" })
        } finally {
            setIsUpdating(false)
        }
    }

    const handleDelete = async (id: number) => {
        try {
            setIsDeleting(id)
            const res = await fetch(`/api/v1/groups/${id}`, { method: "DELETE" })
            if (!res.ok) {
                const errorData = await res.json().catch(() => ({ error: "Deletion failed" }))
                throw new Error(errorData.error || "Deletion failed")
            }

            toast({
                title: "Deleted",
                description: "Group has been removed successfully",
                variant: "default"
            })
            mutate(groupsUrl)
        } catch (e: any) {
            toast({ title: "Error", description: e.message, variant: "destructive" })
        } finally {
            setIsDeleting(null)
            setConfirmDelete({ open: false, id: null })
        }
    }

    const handleManageBranches = async () => {
        try {
            if (!selectedGroup) return
            setIsSaving(true)
            const res = await fetch(`/api/v1/groups/${selectedGroup.id}/branches`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    branchIds: selectedBranchIds,
                    newlyAddedBranchIds: selectedBranchIds.filter(id => !originalBranchIds.includes(id))
                }),
            })

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({ error: "Failed to update branches" }))
                // Show blocked branches info if available
                if (errorData.blockedBranches) {
                    const names = errorData.blockedBranches
                        .map((b: any) => `${b.branchName} (${formatCountLabel(b.productCount, "product")})`)
                        .join(", ")
                    throw new Error(`Clean products first from: ${names}`)
                }
                throw new Error(errorData.error || "Failed to update branches")
            }

            const data = await res.json()
            const autoMsg = data.newlyAddedBranchIds?.length > 0
                ? ` ${formatCountLabel(data.newlyAddedBranchIds.length, "new branch", "new branches")} received group products automatically.`
                : ""
            toast({ title: "Success", description: `Branches assigned successfully.${autoMsg}`, variant: "success" })
            setIsBranchOpen(false)
            mutate(groupsUrl)
            mutateBranches()
        } catch (e: any) {
            toast({ title: "Error", description: e.message, variant: "destructive" })
        } finally {
            setIsSaving(false)
        }
    }

    const handleCleanBranch = async (branchId: number) => {
        try {
            if (!selectedGroup) return
            setIsCleaning(branchId)
            const res = await fetch(`/api/v1/groups/${selectedGroup.id}/branches/clean`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ branchId }),
            })

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({ error: "Failed to clean products" }))
                throw new Error(errorData.error || "Failed to clean products")
            }

            const data = await res.json()
            toast({
                title: "Products Cleaned",
                description: data.message || "All products removed from this branch",
                variant: "success",
            })

            // Update product counts locally
            setBranchProductCounts(prev => ({ ...prev, [branchId]: 0 }))
            // Remove from originalBranchIds so it counts as newly assigned if kept checked
            setOriginalBranchIds(prev => prev.filter(id => id !== branchId))
            setConfirmClean({ open: false, branchId: null, branchName: "" })
        } catch (e: any) {
            toast({ title: "Error", description: e.message, variant: "destructive" })
        } finally {
            setIsCleaning(null)
        }
    }

    const handleReleaseBranch = async (branchId: number) => {
        try {
            setIsReleasing(branchId)
            const res = await fetch(`/api/v1/branches/${branchId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ groupId: null }),
            })

            if (!res.ok) throw new Error("Failed to release branch")

            toast({
                title: "Branch Released",
                description: "Branch is now independent",
                variant: "success"
            })
            mutate(groupsUrl)
            mutateBranches()
        } catch (e: any) {
            toast({ title: "Error", description: e.message, variant: "destructive" })
        } finally {
            setIsReleasing(null)
            setConfirmRelease({ open: false, id: null })
        }
    }

    const openEdit = (group: Group) => {
        setSelectedGroup(group)
        setName(group.name)
        setDescription(group.description)
        setIsEditOpen(true)
    }

    const openBranchManager = async (group: Group) => {
        setSelectedGroup(group)

        // Reset all state and show loading immediately
        setSelectedBranchIds([])
        setOriginalBranchIds([])
        setBranchProductCounts({})
        setTotalGroupProducts(0)
        setBranchSearch("")
        setIsLoadingCounts(true)
        setIsBranchOpen(true)

        try {
            // Fetch fresh branch data directly — don't rely on stale SWR cache
            const orgId = group.organizationId || globalOrgId
            const [freshBranches, countsRes] = await Promise.all([
                fetch(`/api/v1/branches?organizationId=${orgId}`).then(r => r.ok ? r.json() : null),
                fetch(`/api/v1/groups/${group.id}/branch-counts`).then(r => r.ok ? r.json() : null),
            ])

            // Update SWR cache with fresh data
            if (freshBranches) {
                mutateBranches(freshBranches, false)
            }

            // Compute assigned IDs from FRESH data
            const assignedIds = freshBranches?.items
                ?.filter((b: Branch) => b.groupId === group.id)
                .map((b: Branch) => b.id) || []
            setSelectedBranchIds(assignedIds)
            setOriginalBranchIds(assignedIds)

            // Set product counts from parallel fetch
            if (countsRes?.counts) {
                setBranchProductCounts(countsRes.counts)
            }
            if (countsRes?.totalGroupProducts !== undefined) {
                setTotalGroupProducts(Number(countsRes.totalGroupProducts))
            }
        } catch {
            // If fetches fail, fall back to whatever SWR has
            const assignedIds = branchesData?.items
                ?.filter((b: Branch) => b.groupId === group.id)
                .map((b: Branch) => b.id) || []
            setSelectedBranchIds(assignedIds)
            setOriginalBranchIds(assignedIds)
        } finally {
            setIsLoadingCounts(false)
        }
    }

    if (groupsError) return <div>Failed to load groups</div>

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
                <div>
                    <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <Building className="text-blue-600" />
                        Group Management
                    </h2>
                    <p className="text-slate-500 dark:text-slate-400">Manage branch groups for reporting and analytics</p>
                </div>
                {(role === "SUPER_ADMIN" || role === "HEAD_OFFICE") && (
                    <Button onClick={() => setIsCreateOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-md transition-all hover:scale-105">
                        <Plus className="mr-2 h-4 w-4" /> Create Group
                    </Button>
                )}
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
                <Table>
                    <TableHeader className="bg-slate-50 dark:bg-slate-800/50">
                        <TableRow>
                            <TableHead className="font-bold">Group Name</TableHead>
                            {role === "SUPER_ADMIN" && <TableHead className="font-bold">Organization</TableHead>}
                            <TableHead className="font-bold">Description</TableHead>
                            <TableHead className="font-bold">Branches</TableHead>
                            <TableHead className="font-bold">Status</TableHead>
                            <TableHead className="text-right font-bold w-[150px]">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {groupsData?.groups?.map((group: Group) => (
                            <TableRow key={group.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors group cursor-default">
                                <TableCell className="font-medium text-slate-900 dark:text-white">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform">
                                            {group.name.charAt(0)}
                                        </div>
                                        {group.name}
                                    </div>
                                </TableCell>
                                {role === "SUPER_ADMIN" && (
                                    <TableCell>
                                        <Badge variant="outline" className="font-medium bg-blue-50/50 dark:bg-blue-900/10 border-blue-100 dark:border-blue-900/30 text-blue-700 dark:text-blue-400">
                                            {group.organizationName}
                                        </Badge>
                                    </TableCell>
                                )}
                                <TableCell className="text-slate-500 max-w-xs truncate">{group.description}</TableCell>
                                <TableCell>
                                    <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-none font-bold px-3">
                                        {formatCountLabel(group.branchCount, "branch", "branches")}
                                    </Badge>
                                </TableCell>
                                <TableCell>
                                    <Badge className={
                                        (() => {
                                          if (group.status === "connected") {
                                            return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-none px-3 font-bold"
                                          }
                                          if (group.status === "not connected") {
                                            return "bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-none px-3 font-bold"
                                          }
                                          return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-none px-3"
                                        })()
                                    }>
                                        {(() => {
                                          if (group.status === "connected") {
                                            return "Connected"
                                          }
                                          if (group.status === "not connected") {
                                            return "Not Connected"
                                          }
                                          return group.status
                                        })()}
                                    </Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                    <div className="flex justify-end gap-1">
                                        <Button variant="ghost" size="icon" onClick={() => openBranchManager(group)} title="Manage Branches" className="hover:bg-blue-50 hover:text-blue-600 rounded-lg">
                                            <Users className="h-4 w-4" />
                                        </Button>
                                        {(role === "SUPER_ADMIN" || role === "HEAD_OFFICE") && (
                                            <>
                                                <Button variant="ghost" size="icon" onClick={() => openEdit(group)} className="hover:bg-amber-50 hover:text-amber-600 rounded-lg">
                                                    <Pencil className="h-4 w-4" />
                                                </Button>
                                                <Button variant="ghost" size="icon" onClick={() => setConfirmDelete({ open: true, id: group.id })} disabled={isDeleting === group.id} className="hover:bg-rose-50 hover:text-rose-600 rounded-lg">
                                                    <Trash2 className={`h-4 w-4 ${isDeleting === group.id ? "animate-spin" : ""}`} />
                                                </Button>
                                            </>
                                        )}
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                        {(!groupsData?.groups || groupsData.groups.length === 0) && (
                            <TableRow>
                                <TableCell colSpan={6} className="h-32 text-center text-slate-500 italic">
                                    No groups found for this organization.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>

            {/* Create Dialog */}
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <DialogContent className="sm:max-w-[425px] rounded-2xl">
                    <DialogHeader>
                        <DialogTitle className="text-xl font-bold">Create New Group</DialogTitle>
                        <DialogDescription>Add a new branch group for your organization.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="space-y-2">
                            <Label htmlFor="org">Organization</Label>
                            {globalOrgId ? (
                                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex items-center justify-between group">
                                    <div className="flex items-center gap-2">
                                        <Building className="w-4 h-4 text-blue-500" />
                                        <span className="font-medium text-slate-700 dark:text-slate-300">
                                            {currentOrg?.name || "Selected Organization"}
                                        </span>
                                    </div>
                                    <Badge variant="secondary" className="bg-blue-100/50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 border-none">Active</Badge>
                                </div>
                            ) : (
                                <Select onValueChange={setOrganizationId} value={organizationId}>
                                    <SelectTrigger id="org" className="rounded-xl">
                                        <SelectValue placeholder="Select organization" />
                                    </SelectTrigger>
                                    <SelectContent className="rounded-xl">
                                        {orgsData?.items?.map((org: Organization) => (
                                            <SelectItem key={org.id} value={org.id.toString()}>{org.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="name">Group Name</Label>
                            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Downtown Stores" className="rounded-xl" />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="desc">Description</Label>
                            <Textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Group purpose..." className="rounded-xl resize-none h-24" />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsCreateOpen(false)} disabled={isCreating} className="rounded-xl">Cancel</Button>
                        <Button onClick={handleCreate} disabled={isCreating} className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-6">
                            {isCreating ? "Creating..." : "Create"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Edit Dialog */}
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
                <DialogContent className="sm:max-w-[425px] rounded-2xl">
                    <DialogHeader>
                        <DialogTitle className="text-xl font-bold">Edit Group</DialogTitle>
                        <DialogDescription>Modify group details.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="space-y-2">
                            <Label htmlFor="edit-name">Group Name</Label>
                            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl" />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="edit-desc">Description</Label>
                            <Textarea id="edit-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="rounded-xl resize-none h-24" />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isUpdating} className="rounded-xl">Cancel</Button>
                        <Button onClick={handleUpdate} disabled={isUpdating} className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-6">
                            {isUpdating ? "Saving..." : "Save Changes"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Branch Assignment Dialog */}
            <Dialog open={isBranchOpen} onOpenChange={setIsBranchOpen}>
                <DialogContent className="sm:max-w-[550px] rounded-2xl">
                    <DialogHeader>
                        <DialogTitle className="text-xl font-bold">Assign Branches - {selectedGroup?.name}</DialogTitle>
                        <DialogDescription>Select branches to include in this group.</DialogDescription>
                    </DialogHeader>
                    <div className="py-4 space-y-4">
                        <div className="flex flex-col gap-2">
                            <Label className="font-semibold text-slate-700 dark:text-slate-300">Available Branches</Label>
                            <div className="relative group">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
                                <Input 
                                    placeholder="Search branches..." 
                                    value={branchSearch}
                                    onChange={(e) => setBranchSearch(e.target.value)}
                                    className="pl-9 h-10 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 focus-visible:ring-blue-500/20"
                                />
                            </div>
                        </div>
                        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-slate-50/50 dark:bg-slate-900/50">
                            <ScrollArea className="h-[350px] p-4">
                                {(() => {
                                  if (isLoadingCounts) {
                                    return (
                                    <div className="h-full flex flex-col items-center justify-center space-y-3 text-slate-500">
                                        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                                        <p>Loading assigned branches...</p>
                                    </div>
                                )
                                  }
                                  return (
                                    <div className="space-y-2">
                                        {branchesData?.items?.filter((b: Branch) => b.name.toLowerCase().includes(branchSearch.toLowerCase())).map((branch: Branch) => {
                                            const isInThisGroup = branch.groupId === selectedGroup?.id
                                            const isInOtherGroup = !!(branch.groupId && branch.groupId !== selectedGroup?.id)
                                            const productCount = branchProductCounts[branch.id] || 0
                                            const hasProducts = isInThisGroup && productCount > 0
                                            const isNewlyAdded = selectedBranchIds.includes(branch.id) && !originalBranchIds.includes(branch.id)
                                            const willGetProducts = isNewlyAdded && totalGroupProducts > 0

                                            return (
                                                <div key={branch.id} className={`flex items-center space-x-3 p-3 rounded-lg transition-colors group ${(() => {
                                                  if (hasProducts) {
                                                    return "bg-amber-50/50 dark:bg-amber-950/10 border border-amber-100 dark:border-amber-900/30"
                                                  }
                                                  if (willGetProducts) {
                                                    return "bg-emerald-50/50 dark:bg-emerald-950/10 border border-emerald-100 dark:border-emerald-900/30"
                                                  }
                                                  return "hover:bg-white dark:hover:bg-slate-800"
                                                })()
                                                    }`}>
                                                    <Checkbox
                                                        id={`branch-${branch.id}`}
                                                        checked={selectedBranchIds.includes(branch.id)}
                                                        disabled={isInOtherGroup || hasProducts}
                                                        onCheckedChange={(checked) => {
                                                            if (hasProducts) {
                                                                toast({
                                                                    title: "Cannot remove branch",
                                                                    description: `"${branch.name}" has ${formatCountLabel(productCount, "product")} assigned. Clean products first.`,
                                                                    variant: "destructive"
                                                                })
                                                                return
                                                            }
                                                            if (checked) {
                                                                setSelectedBranchIds([...selectedBranchIds, branch.id])
                                                            } else {
                                                                setSelectedBranchIds(selectedBranchIds.filter(id => id !== branch.id))
                                                            }
                                                        }}
                                                        className="rounded-md border-slate-300 text-blue-600 data-[state=checked]:bg-blue-600"
                                                    />
                                                    <div className="flex-1 min-w-0">
                                                        <Label htmlFor={`branch-${branch.id}`} className={`cursor-pointer font-medium transition-colors ${hasProducts ? "text-amber-700 dark:text-amber-400" : "text-slate-700 dark:text-slate-300 group-hover:text-blue-600"
                                                            }`}>
                                                            {branch.name}
                                                        </Label>
                                                        {isInOtherGroup && (
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 bg-amber-50 py-0 px-1.5 h-5">
                                                                    In group: {branch.groupName || `Group #${branch.groupId}`}
                                                                </Badge>
                                                                <span className="text-[10px] text-slate-500">
                                                                    Go to that group to release this branch
                                                                </span>
                                                            </div>
                                                        )}
                                                        {isInThisGroup && hasProducts && (
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 bg-amber-50 py-0 px-1.5 h-5">
                                                                    <Package className="h-3 w-3 mr-1" />
                                                                    {formatCountLabel(productCount, "product")} assigned
                                                                </Badge>
                                                                <span className="text-[10px] text-slate-500">
                                                                    Clean products to release
                                                                </span>
                                                            </div>
                                                        )}
                                                        {willGetProducts && (
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-200 bg-emerald-50 py-0 px-1.5 h-5">
                                                                    <Package className="h-3 w-3 mr-1" />
                                                                    Will receive group products on save
                                                                </Badge>
                                                            </div>
                                                        )}
                                                    </div>
                                                    {/* Clean button for branches in this group with products */}
                                                    {isInThisGroup && hasProducts && (
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={isCleaning === branch.id}
                                                            onClick={(e) => {
                                                                e.preventDefault()
                                                                setConfirmClean({ open: true, branchId: branch.id, branchName: branch.name })
                                                            }}
                                                            className="shrink-0 h-7 px-2 text-xs rounded-lg border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/30"
                                                        >
                                                            {isCleaning === branch.id ? (
                                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                            ) : (
                                                                <><Eraser className="h-3 w-3 mr-1" /> Clean</>
                                                            )}
                                                        </Button>
                                                    )}
                                                </div>
                                            )
                                        })}
                                        {(!branchesData?.items || branchesData.items.length === 0) && (
                                            <div className="text-center py-12 text-slate-400">No branches found for this organization.</div>
                                        )}
                                        {branchesData?.items?.length > 0 && branchesData.items.filter((b: Branch) => b.name.toLowerCase().includes(branchSearch.toLowerCase())).length === 0 && (
                                            <div className="text-center py-12 text-slate-400">
                                                <p className="font-medium text-slate-500">No matches found for "{branchSearch}"</p>
                                                <p className="text-xs">Try a different search term</p>
                                            </div>
                                        )}
                                    </div>
                                )
                                })()}
                            </ScrollArea>
                        </div>
                        <p className="mt-4 text-xs text-slate-500 flex items-start gap-2">
                            <AlertCircle size={14} className="mt-0.5 text-amber-500 shrink-0" />
                            New branches will automatically receive all products assigned in this group. Branches with products cannot be removed — clean first.
                        </p>
                    </div>
                    <DialogFooter className="flex flex-col sm:flex-row gap-3">
                        <div className="flex-1 flex items-center">
                        </div>
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={() => setIsBranchOpen(false)} className="rounded-xl">Cancel</Button>
                            <Button
                                onClick={handleManageBranches}
                                disabled={isSaving}
                                className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-8 shadow-lg shadow-blue-500/20"
                            >
                                {isSaving ? (
                                    <>Saving...</>
                                ) : (
                                    <>
                                        <CheckCircle2 className="mr-2 h-4 w-4" /> Save Assignments
                                    </>
                                )}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Clean Products Confirm Dialog */}
            <PremiumConfirmDialog
                open={confirmClean.open}
                onOpenChange={(v) => !isCleaning && setConfirmClean({ open: v, branchId: confirmClean.branchId, branchName: confirmClean.branchName })}
                onConfirm={() => confirmClean.branchId && handleCleanBranch(confirmClean.branchId)}
                title={`Clean Products from "${confirmClean.branchName}"?`}
                description={`This will remove all ${formatCountLabel(branchProductCounts[confirmClean.branchId || 0] || 0, "product")} assigned to this branch. The branch can then be removed from the group.`}
                confirmText="Clean All Products"
                type="danger"
                isLoading={isCleaning !== null}
            />

            {/* Premium Confirm Dialogs */}
            <PremiumConfirmDialog
                open={confirmDelete.open}
                onOpenChange={(v) => !isDeleting && setConfirmDelete({ open: v, id: confirmDelete.id })}
                onConfirm={() => confirmDelete.id && handleDelete(confirmDelete.id)}
                title="Delete Group?"
                description="This action cannot be undone. All branches assigned to this group will become independent."
                confirmText="Delete Group"
                type="danger"
                isLoading={isDeleting !== null}
            />

            <PremiumConfirmDialog
                open={confirmRelease.open}
                onOpenChange={(v) => !isReleasing && setConfirmRelease({ open: v, id: confirmRelease.id })}
                onConfirm={() => confirmRelease.id && handleReleaseBranch(confirmRelease.id)}
                title="Release Branch?"
                description="This branch will be removed from the group and return to the independent branch pool."
                confirmText="Release"
                type="warning"
                isLoading={isReleasing !== null}
            />
        </div>
    )
}
