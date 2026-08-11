"use client"

import { useEffect,useState } from "react"
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card"
import { MFASettings } from "@/components/mfa/mfa-settings"
import { useSession } from "next-auth/react"
import { User,Shield,Building2,GitBranch,Mail,Clock3 } from "lucide-react"
import useSWR from "swr"
import { useAppContext } from "@/components/context/app-context"

export default function SettingsPage() {
  const { data: session } = useSession()
  console.log(session, "session from settings page", (session?.user as any)?.fullName)
  const userEmail = (session?.user as any)?.email
  const username = (session?.user as any)?.username
  const { organizationId: contextOrgId, branchId: contextBranchId } = useAppContext()

  // Prefer active context (from header selector); fall back to user's assigned org/branch
  const organizationId =
    (contextOrgId ? Number(contextOrgId) : (session?.user as any)?.organizationId) as
    | number
    | undefined
  const branchId =
    (contextBranchId ? Number(contextBranchId) : (session?.user as any)?.branchId) as
    | number
    | undefined
  const [lastLoginDate, setLastLoginDate] = useState<string>("—")
  const [lastLoginTime, setLastLoginTime] = useState<string>("")

  const fetcher = (url: string) => fetch(url).then((r) => r.json())

  const { data: orgData } = useSWR(
    organizationId ? `/api/v1/organizations/${organizationId}` : null,
    fetcher
  )
  const { data: branchData } = useSWR(
    branchId ? `/api/v1/branches/${branchId}` : null,
    fetcher
  )

  const organizationName =
    orgData?.item?.name ||
    (session?.user as any)?.organizationName ||
    (organizationId ? `Organization #${organizationId}` : "Unassigned")

  const branchName =
    branchData?.item?.name ||
    (session?.user as any)?.branchName ||
    (branchId ? `Branch #${branchId}` : "All branches")

  // Avoid hydration mismatches by setting date/time only on client
  useEffect(() => {
    const now = new Date()
    setLastLoginDate(now.toLocaleDateString())
    setLastLoginTime(now.toLocaleTimeString())
  }, [])

  const heroStats = [
    {
      label: "Role",
      value: ((session?.user as any)?.role || "N/A").toString().replace(/_/g, " "),
      icon: Shield,
      gradient: "from-sky-400 to-indigo-500",
      sub: "Current permissions",
    },
    {
      label: "Organization",
      value: organizationName,
      icon: Building2,
      gradient: "from-purple-400 to-fuchsia-500",
      sub: "Primary org",
    },
    {
      label: "Branch",
      value: branchName,
      icon: GitBranch,
      gradient: "from-emerald-400 to-teal-500",
      sub: "Active branch context",
    },
    {
      label: "Last login",
      value: lastLoginDate,
      icon: Clock3,
      gradient: "from-amber-400 to-orange-500",
      sub: lastLoginTime || "Recently",
    },
  ]

  return (
    <div className="space-y-6 p-6 bg-slate-50 dark:bg-slate-950 min-h-screen">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-[#121F6F] via-[#2C3AD1] to-[#7C3AED] px-6 py-6 text-white shadow-xl ring-1 ring-indigo-500/30">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.2em] text-white/70">
              {((session?.user as any)?.role || "HEAD_OFFICE").toString().replace(/_/g, " ")} · ACCOUNT
            </p>
            <h1 className="text-3xl font-semibold">Preferences & security</h1>
            <p className="text-sm text-white/80">
              Review your profile, MFA, and notifications to keep your workspace secure.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {heroStats.map((stat) => {
          const Icon = stat.icon
          return (
            <Card key={stat.label} className="rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
              <div className={`mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br ${stat.gradient} text-white shadow-inner`}>
                <Icon className="h-5 w-5" />
              </div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{stat.label}</p>
              <p className="text-2xl font-semibold text-slate-900 dark:text-white capitalize">{stat.value}</p>
              <p className="text-sm text-muted-foreground">{stat.sub}</p>
            </Card>
          )
        })}
      </div>


      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile Settings */}
        <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-slate-900 dark:text-white">
              <User className="h-5 w-5" />
              Profile Information
            </CardTitle>
            <CardDescription>
              Manage your personal information and account details
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Full Name</p>
                <p className="text-sm text-muted-foreground">
                  {(session?.user as any)?.fullName || "N/A"}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Username</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {username || "N/A"}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Email Address</p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Mail className="h-4 w-4" />
                  <span>{userEmail || "N/A"}</span>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Role</p>
                <p className="text-sm text-muted-foreground">
                  {(session?.user as any)?.role || "N/A"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Security Settings */}
        <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-slate-900 dark:text-white">
              <Shield className="h-5 w-5" />
              Security Settings
            </CardTitle>
            <CardDescription>
              Manage your account security and authentication
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MFASettings username={username} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
