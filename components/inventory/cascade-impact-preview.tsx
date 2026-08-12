import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Building2, Home, Users } from "lucide-react"
import { cn } from "@/lib/utils"

interface CascadeImpactPreviewProps {
  type: "delete" | "status-change" | "unassign"
  affectedOrgs: number
  affectedBranches: number
  className?: string
}

export function CascadeImpactPreview({
  type,
  affectedOrgs,
  affectedBranches,
  className
}: Readonly<CascadeImpactPreviewProps>) {
  const getActionDescription = () => {
    switch (type) {
      case "delete":
        return "This will permanently remove the product from:"
      case "status-change":
        return "This will update the status for:"
      case "unassign":
        return "This will unassign the product from:"
      default:
        return "This action will affect:"
    }
  }

  const getSeverity = () => {
    if (affectedBranches > 50 || affectedOrgs > 10) return "destructive"
    if (affectedBranches > 10 || affectedOrgs > 3) return "default"
    return "default"
  }

  return (
    <Alert
      variant={getSeverity()}
      className={cn("border-l-4", className)}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="space-y-2">
        <p className="font-medium">{getActionDescription()}</p>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="flex items-center gap-1">
            <Building2 className="h-3 w-3" />
            <span>{affectedOrgs} organization{affectedOrgs !== 1 ? 's' : ''}</span>
          </Badge>
          <Badge variant="outline" className="flex items-center gap-1">
            <Home className="h-3 w-3" />
            <span>{affectedBranches} branch{affectedBranches !== 1 ? 'es' : ''}</span>
          </Badge>
          <Badge variant="outline" className="flex items-center gap-1">
            <Users className="h-3 w-3" />
            <span>All users in affected branches</span>
          </Badge>
        </div>
        {type === "delete" && (
          <p className="text-sm text-muted-foreground">
            This action cannot be undone. All associated data will be permanently removed.
          </p>
        )}
      </AlertDescription>
    </Alert>
  )
}
