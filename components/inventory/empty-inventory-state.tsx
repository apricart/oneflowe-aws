import { Package, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

interface EmptyInventoryStateProps {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  icon?: React.ReactNode
}

export function EmptyInventoryState({
  title,
  description,
  actionLabel,
  onAction,
  icon = <Package className="h-12 w-12 text-muted-foreground" />
}: Readonly<EmptyInventoryStateProps>) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-4">
          {icon}
        </div>
        <h3 className="text-lg font-semibold text-muted-foreground mb-2">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground mb-6 max-w-sm">
          {description}
        </p>
        {actionLabel && onAction && (
          <Button onClick={onAction} className="gap-2">
            <Plus className="h-4 w-4" />
            {actionLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
