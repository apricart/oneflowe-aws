"use client"

import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card"
import { SectionHeader } from "@/components/ui/section-header"
import { EmployeeCredentialsManager } from "@/components/admin/employee-credentials-manager"
import { useSession } from "next-auth/react"
import { Users,UserCheck,UserX,Shield,Building2 } from "lucide-react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"

export default function EmployeeManagementPage() {
  const { data: session } = useSession()
  const userRole = (session?.user as any)?.role
  const isBranchAdmin = userRole === "BRANCH_ADMIN"

  // Fetch employee credentials data for statistics
  const { data: credentialsData } = useSWR<any>("/api/v1/employee-credentials", fetcher)
  const credentials = credentialsData?.credentials || []

  // Calculate statistics
  const totalEmployees = credentials.length
  const activeEmployees = credentials.filter((emp: any) => emp.isActive).length
  const inactiveEmployees = credentials.filter((emp: any) => !emp.isActive).length
  const mfaEnabledEmployees = credentials.filter((emp: any) => emp.mfaEnabled).length

  if (!isBranchAdmin) {
    return (
      <div className="space-y-6 p-6">
        <SectionHeader
          title="Access Denied"
          subtitle="You don't have permission to access employee management"
        />
        <Card>
          <CardContent className="p-6">
            <p className="text-muted-foreground">
              Employee management is only available to Branch Administrators.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 space-y-6 p-6">
      <SectionHeader
        title="Employee Management"
        subtitle="Manage employee credentials and access to the Order Portal"
        actions={
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            Branch Employee Portal
          </div>
        }
      />

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-900 dark:text-white">Total Employees</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">{totalEmployees}</div>
            <p className="text-xs text-muted-foreground">
              All employee accounts
            </p>
          </CardContent>
        </Card>

        <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-900 dark:text-white">Active Employees</CardTitle>
            <UserCheck className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{activeEmployees}</div>
            <p className="text-xs text-muted-foreground">
              Currently active accounts
            </p>
          </CardContent>
        </Card>

        <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-900 dark:text-white">Inactive Employees</CardTitle>
            <UserX className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{inactiveEmployees}</div>
            <p className="text-xs text-muted-foreground">
              Deactivated accounts
            </p>
          </CardContent>
        </Card>

        <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-900 dark:text-white">MFA Enabled</CardTitle>
            <Shield className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{mfaEnabledEmployees}</div>
            <p className="text-xs text-muted-foreground">
              Enhanced security enabled
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Employee Credentials Management */}
      <Card className="border-blue-200 dark:border-blue-800 bg-white dark:bg-slate-900">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-slate-900 dark:text-white">
            <Users className="h-5 w-5" />
            Employee Portal Access
          </CardTitle>
          <CardDescription>
            Create and manage employee credentials for the Order Portal. Employees can use these credentials to access the shop portal and place orders.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmployeeCredentialsManager />
        </CardContent>
      </Card>

      {/* Information Card */}
      <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-slate-900 dark:text-white">
            <Building2 className="h-5 w-5" />
            About Employee Management
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <h4 className="font-medium mb-2 text-slate-900 dark:text-white">What are Employee Credentials?</h4>
              <p className="text-sm text-muted-foreground">
                Employee credentials allow your branch staff to access the Order Portal where they can place orders,
                view inventory, and manage their work-related tasks. Each employee gets their own secure login.
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-2 text-slate-900 dark:text-white">Security Features</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Multi-Factor Authentication (MFA) support</li>
                <li>• Secure password hashing</li>
                <li>• Branch-specific access control</li>
                <li>• Audit logging for all actions</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-2 text-slate-900 dark:text-white">Employee Access</h4>
              <p className="text-sm text-muted-foreground">
                Once created, employees can log in at the Order Portal using their email and password.
                They will have access to place orders within your branch's budget limits.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
