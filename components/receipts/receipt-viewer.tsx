"use client"

import React from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { ReceiptContent } from "./receipt-content"

interface ReceiptViewerProps {
    orderId: number
    open: boolean
    onOpenChange: (open: boolean) => void
}

export function ReceiptViewer({ orderId, open, onOpenChange }: Readonly<ReceiptViewerProps>) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[850px] p-0 border-0 bg-transparent shadow-none overflow-visible">
                <ReceiptContent
                    orderId={orderId}
                    onClose={() => onOpenChange(false)}
                />
            </DialogContent>
        </Dialog>
    )
}
