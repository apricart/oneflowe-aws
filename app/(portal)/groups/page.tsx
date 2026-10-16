import { viewerReadRole } from "@/lib/viewer-access"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { redirect } from "next/navigation"
import { GroupManagement } from "@/components/admin/group-management"

export default async function GroupsPage() {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
        redirect("/login")
    }

    // An organization-wide Viewer reads the page as Head Office; the component
    // hides every control that changes a group.
    const role = viewerReadRole(session.user as any)
    if (role !== "SUPER_ADMIN" && role !== "HEAD_OFFICE") {
        redirect("/dashboard")
    }

    return (
        <div className="container mx-auto py-8 px-4 max-w-7xl animate-in fade-in slide-in-from-bottom-4 duration-700">
            <GroupManagement role={role} />
        </div>
    )
}
