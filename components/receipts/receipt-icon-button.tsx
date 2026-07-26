"use client"

import React from "react"
import { FileText } from "lucide-react"
import Link from "next/link"
import { isInvoiceAvailableForOrder } from "@/lib/invoice-availability"
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"

interface ReceiptIconButtonProps {
    orderId: number
    orderStatus: string | null | undefined
    statusAtRefund?: string | null
    variant?: "ghost" | "outline" | "default"
    size?: "sm" | "default" | "lg"
    showLabel?: boolean
}

export function ReceiptIconButton({
    orderId,
    orderStatus,
    statusAtRefund,
    variant = "ghost",
    size = "sm",
    showLabel = false,
}: ReceiptIconButtonProps) {
    if (!isInvoiceAvailableForOrder({ status: orderStatus, statusAtRefund })) {
        return null
    }

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Link
                        href={`/invoices/${orderId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 gap-1 ${variant === "ghost"
                            ? "hover:bg-accent hover:text-accent-foreground"
                            : variant === "outline"
                                ? "border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground"
                                : "bg-primary text-primary-foreground shadow hover:bg-primary/80"
                            } ${size === "sm" ? "h-8 px-3" : size === "lg" ? "h-10 px-8" : "h-9 px-4"
                            }`}
                    >
                        <FileText className="h-4 w-4" />
                        {showLabel && "Invoice"}
                    </Link>
                </TooltipTrigger>
                <TooltipContent>
                    <p>View Invoice</p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    )
}
