import type { CSSProperties } from "react"

/**
 * The height the product-request dialogs may take: the viewport less a margin,
 * so the header and the fixed action bar are always on screen and only the
 * body between them scrolls. Plain `vh`, which every browser supports — a
 * `min()` with `dvh` would be dropped whole by a browser without `dvh`,
 * leaving no limit at all.
 */
export const DIALOG_FITS_SCREEN: CSSProperties = {
  maxHeight: "calc(100vh - 2rem)",
}
