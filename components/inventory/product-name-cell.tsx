"use client"

import { Package } from "lucide-react"
import { Tooltip,TooltipContent,TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type ProductNameCellProps = {
    name: string
    imageUrl?: string | null
    /** Caps how wide the name may grow before it ellipsises. */
    className?: string
}

/**
 * Product thumbnail + name for inventory tables. The name is capped so a long
 * product name cannot stretch the Product column across the whole table; the
 * full name is shown on hover.
 */
export function ProductNameCell({ name,imageUrl,className }: Readonly<ProductNameCellProps>) {
    return (
        <div className="flex items-center gap-3">
            {imageUrl ? (
                <img
                    src={imageUrl}
                    alt={name}
                    className="h-10 w-10 shrink-0 rounded-lg border object-cover"
                />
            ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
                    <Package className="h-4 w-4 text-muted-foreground" />
                </div>
            )}
            <Tooltip>
                <TooltipTrigger asChild>
                    <span
                        className={cn(
                            "block truncate font-medium",
                            "max-w-[200px] sm:max-w-[280px] lg:max-w-[360px]",
                            className,
                        )}
                    >
                        {name}
                    </span>
                </TooltipTrigger>
                <TooltipContent side="top" align="start" className="max-w-sm whitespace-normal">
                    {name}
                </TooltipContent>
            </Tooltip>
        </div>
    )
}
