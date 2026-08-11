"use client"

import { useAppContext } from "@/components/context/app-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import { Loader2,RefreshCw,Search,Upload } from "lucide-react"
import { useState } from "react"
import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then(res => res.json())

import { GlobalDateFilter,type FilterPreset,type GlobalDateFilterChange } from "@/components/dashboard/global-date-filter"
export function AuditLogViewer() {
  const { organizationId, branchId } = useAppContext()
  const [actionFilter, setActionFilter] = useState<string>("all")
  const [resourceTypeFilter, setResourceTypeFilter] = useState<string>("all")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [activePreset, setActivePreset] = useState<FilterPreset>("today")
  const [searchTerm, setSearchTerm] = useState("")

  const handleDateChange = ({ range, preset }: GlobalDateFilterChange) => {
    setActivePreset(preset)
    if (range) {
      setStartDate(range.startDate.toISOString())
      setEndDate(range.endDate.toISOString())
    } else {
      setStartDate("")
      setEndDate("")
    }
  }

  // Build query parameters based on global context and local filters
  const queryParams = new URLSearchParams()
  if (organizationId) queryParams.append("organizationId", organizationId)
  if (branchId && branchId !== "all") queryParams.append("branchId", branchId)
  if (actionFilter !== "all") queryParams.append("action", actionFilter)
  if (resourceTypeFilter !== "all") queryParams.append("resourceType", resourceTypeFilter)
  if (startDate) queryParams.append("startDate", startDate)
  if (endDate) queryParams.append("endDate", endDate)

  const { data, isLoading, mutate } = useSWR(`/api/v1/audit-logs?${queryParams.toString()}`, fetcher)

  const handleExportPDF = () => {
    const doc = new jsPDF('l', 'mm', 'a4') // Landscape orientation

    doc.setFontSize(20)
    doc.text("Audit Logs Report", 14, 20)

    doc.setFontSize(10)
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)

    // Context Info
    let filterText = ""
    if (organizationId) filterText += `Org: ${organizationId} `
    if (branchId) filterText += `Branch: ${branchId} `
    if (startDate || endDate) filterText += `Range: ${new Date(startDate).toLocaleDateString()} - ${new Date(endDate).toLocaleDateString()}`
    if (filterText) doc.text(filterText, 14, 33)

    const tableData = (data?.items || []).map((log: any) => [
      new Date(log.createdAt).toLocaleString(),
      log.userEmail || log.userId,
      log.action,
      log.resourceType,
      log.resourceId || "-",
      typeof log.details === 'object' ? JSON.stringify(log.details) : log.details || "-",
      log.ipAddress || "-"
    ])

    autoTable(doc, {
      startY: 40,
      head: [["Date", "User", "Action", "Resource", "ID", "Details", "IP"]],
      body: tableData,
      theme: 'grid',
      styles: { fontSize: 8 },
      headStyles: { fillColor: [79, 70, 229] }
    })

    doc.save(`audit-logs-${Date.now()}.pdf`)
  }

  const logs = data?.items || []
  const filteredLogs = logs.filter((log: any) =>
    log.userId?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    log.userEmail?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    log.action?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    log.resourceType?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (log.details && JSON.stringify(log.details).toLowerCase().includes(searchTerm.toLowerCase()))
  )

  return (
    <div className="space-y-6">
      {/* Premium Filter Header */}
      <Card className="p-4 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-slate-200 dark:border-slate-800 shadow-xl rounded-2xl">
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-4">
            {/* Standardized Date Filter */}
            <GlobalDateFilter
              value={startDate && endDate ? { startDate: new Date(startDate), endDate: new Date(endDate) } : null}
              onChange={handleDateChange}
              activePreset={activePreset}
            />

            <div className="h-6 w-px bg-slate-200 dark:bg-slate-800 hidden md:block" />

            {/* Premium Action Filter */}
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="w-[160px] h-10 rounded-xl bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-xs font-bold ring-offset-background focus:ring-2 focus:ring-ring">
                <SelectValue placeholder="Action" />
              </SelectTrigger>
              <SelectContent className="rounded-xl border-slate-200 dark:border-slate-800 shadow-2xl p-1.5 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md">
                <SelectItem value="all" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">All Actions</SelectItem>
                <SelectItem value="LOGIN" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">LOGIN</SelectItem>
                <SelectItem value="CREATE" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">CREATE</SelectItem>
                <SelectItem value="UPDATE" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">UPDATE</SelectItem>
                <SelectItem value="DELETE" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">DELETE</SelectItem>
              </SelectContent>
            </Select>

            {/* Premium Resource Filter */}
            <Select value={resourceTypeFilter} onValueChange={setResourceTypeFilter}>
              <SelectTrigger className="w-[160px] h-10 rounded-xl bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-xs font-bold ring-offset-background focus:ring-2 focus:ring-ring">
                <SelectValue placeholder="Resource" />
              </SelectTrigger>
              <SelectContent className="rounded-xl border-slate-200 dark:border-slate-800 shadow-2xl p-1.5 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md">
                <SelectItem value="all" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">All Resources</SelectItem>
                <SelectItem value="ORDER" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">ORDER</SelectItem>
                <SelectItem value="USER" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">USER</SelectItem>
                <SelectItem value="BRANCH" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">BRANCH</SelectItem>
                <SelectItem value="BUDGET" className="rounded-lg px-3 py-2 text-xs font-semibold focus:bg-indigo-50 dark:focus:bg-indigo-900/40 focus:text-indigo-600 dark:focus:text-indigo-400">BUDGET</SelectItem>
              </SelectContent>
            </Select>

            {/* Search */}
            <div className="relative flex-1 min-w-[240px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search by User, Action, Resource or Details..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="pl-9 h-10 text-xs bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 rounded-xl focus:ring-indigo-500/50"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
              {isLoading ? "Syncing Logs..." : `${filteredLogs.length} Records Found`}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => mutate()}
                disabled={isLoading}
                className="h-9 rounded-lg text-xs font-bold gap-2 px-4"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={handleExportPDF}
                disabled={logs.length === 0}
                className="h-9 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white gap-2 px-4 shadow-lg shadow-indigo-500/20"
              >
                <Upload className="h-3.5 w-3.5" />
                Export PDF
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden border-none shadow-none">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-[180px]">Timestamp</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Details</TableHead>
              <TableHead className="text-right">IP Address</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(() => {
              if (isLoading) {
                return (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            )
              }
              if (filteredLogs.length === 0) {
                return (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                  No logs found for the selected criteria.
                </TableCell>
              </TableRow>
            )
              }
              return (
              filteredLogs.map((log: any) => (
                <TableRow key={log.id} className="hover:bg-muted/30 transition-colors">
                  <TableCell className="text-xs font-mono text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{log.userEmail || "System"}</span>
                      <span className="text-[10px] text-muted-foreground uppercase">{log.userRole || "unknown"}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={(() => {
                      if (log.action === 'DELETE') {
                        return 'destructive'
                      }
                      if (log.action === 'CREATE') {
                        return 'default'
                      }
                      return 'outline'
                    })()} className="text-[10px]">
                      {log.action}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-xs font-medium">{log.resourceType}</span>
                      <span className="text-[10px] text-muted-foreground">ID: {log.resourceId || "N/A"}</span>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[400px]">
                    <div className="text-xs truncate" title={typeof log.details === 'object' ? JSON.stringify(log.details) : log.details}>
                      {typeof log.details === 'object' ? JSON.stringify(log.details) : log.details}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono text-muted-foreground">
                    {log.ipAddress || "0.0.0.0"}
                  </TableCell>
                </TableRow>
              ))
            )
            })()}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
