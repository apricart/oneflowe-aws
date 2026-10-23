"use client"

import { useState } from "react"
import { ExternalLink, ImageOff, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

type LoadState = "loading" | "loaded" | "error"

/**
 * The screenshot of the customer's message the Order Desk attached when it
 * keyed the order in, shown inline and opening full size in a new tab.
 *
 * `src` is the reader's own endpoint — the order readers'
 * `/api/v1/orders/{id}/intake-screenshot` or the warehouse's — and that
 * endpoint is the control: it serves the image only under the reader's own
 * rule for the order, and answers anything else 404, which shows here as
 * "could not be loaded".
 */
export function OrderIntakeScreenshot({
  src,
  orderTid,
  className,
}: Readonly<{ src: string; orderTid: string; className?: string }>) {
  // Keyed on the source so opening another order starts from "loading" again.
  return <IntakeScreenshotImage key={src} src={src} orderTid={orderTid} className={className} />
}

function IntakeScreenshotImage({
  src,
  orderTid,
  className,
}: Readonly<{ src: string; orderTid: string; className?: string }>) {
  const [state, setState] = useState<LoadState>("loading")

  if (state === "error") {
    return (
      <p role="status" className={cn("flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground", className)}>
        <ImageOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        The customer&apos;s screenshot could not be loaded.
      </p>
    )
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("group block overflow-hidden rounded-lg border bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      {state === "loading" && (
        <span className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Loading screenshot…
        </span>
      )}
      {/* An authenticated application path served with no-store, not a static asset. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`Screenshot of the customer's message for order ${orderTid}`}
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className={cn("max-h-96 w-full object-contain", state === "loading" && "hidden")}
      />
      <span className="flex items-center justify-end gap-1 border-t bg-background/80 px-3 py-1.5 text-xs text-muted-foreground group-hover:text-foreground">
        Open full size <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </span>
    </a>
  )
}
