"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface CategoryRibbonProps {
  items: readonly string[]
  activeItem: string
  onSelect: (item: string) => void
}

/** How much of the visible width one arrow press travels. */
const SCROLL_RATIO = 0.75
/** Breathing room left beside a chip that is scrolled into view. */
const CHIP_MARGIN = 16

function ScrollArrow({
  side,
  onClick,
}: Readonly<{ side: "left" | "right"; onClick: () => void }>) {
  const isLeft = side === "left"
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 flex items-center",
        isLeft
          ? "left-0 bg-gradient-to-r pr-8"
          : "right-0 bg-gradient-to-l pl-8",
        "from-white via-white/85 to-transparent dark:from-slate-900 dark:via-slate-900/85",
      )}
    >
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label={`Scroll categories ${side}`}
        onClick={onClick}
        className="pointer-events-auto h-7 w-7 rounded-full border-slate-200/80 bg-white/90 shadow-sm backdrop-blur-md hover:bg-white dark:border-slate-700/80 dark:bg-slate-800/90 dark:hover:bg-slate-800"
      >
        {isLeft ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}

/**
 * Horizontal subcategory chips. The native scrollbar is hidden in favour of
 * edge arrows, which only appear on the side that still has chips to reveal.
 */
export function CategoryRibbon({ items, activeItem, onSelect }: Readonly<CategoryRibbonProps>) {
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = React.useState({ left: false, right: false })

  const syncOverflow = React.useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const maxScroll = scroller.scrollWidth - scroller.clientWidth
    setOverflow({
      left: scroller.scrollLeft > 1,
      // A sub-pixel remainder must not leave a dead arrow on screen.
      right: scroller.scrollLeft < maxScroll - 1,
    })
  }, [])

  // Arrows have to answer to more than scrolling: the chip list changes with
  // the selected category, and the panel reflows with the viewport.
  React.useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    syncOverflow()
    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(syncOverflow)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [syncOverflow, items])

  // Choosing a subcategory in the picker can activate a chip that is scrolled
  // out of sight, so bring it back without disturbing the rest of the page.
  React.useEffect(() => {
    const scroller = scrollerRef.current
    const chip = scroller?.querySelector<HTMLElement>("[data-active='true']")
    if (!scroller || !chip) return

    const chipEnd = chip.offsetLeft + chip.offsetWidth
    if (chip.offsetLeft < scroller.scrollLeft) {
      scroller.scrollTo({ left: Math.max(0, chip.offsetLeft - CHIP_MARGIN), behavior: "smooth" })
    } else if (chipEnd > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollTo({ left: chipEnd - scroller.clientWidth + CHIP_MARGIN, behavior: "smooth" })
    }
  }, [activeItem])

  const scrollByPage = (direction: -1 | 1) => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollBy({ left: direction * scroller.clientWidth * SCROLL_RATIO, behavior: "smooth" })
  }

  if (items.length <= 1) return null

  return (
    <div className="relative mt-3 border-t border-slate-200/60 pt-3 dark:border-slate-700/50">
      {overflow.left && <ScrollArrow side="left" onClick={() => scrollByPage(-1)} />}

      <div
        ref={scrollerRef}
        onScroll={syncOverflow}
        data-testid="shop-category-ribbon"
        className="no-scrollbar flex items-center gap-1.5 overflow-x-auto scroll-smooth"
      >
        {items.map((item) => {
          const isActive = activeItem === item
          return (
            <Button
              key={item}
              size="sm"
              variant="ghost"
              data-active={isActive}
              onClick={() => onSelect(item)}
              className={cn(
                "h-8 shrink-0 rounded-full px-3.5 text-xs font-semibold whitespace-nowrap transition-colors",
                isActive
                  ? "bg-blue-600 text-white shadow-sm shadow-blue-500/25 hover:bg-blue-600 hover:text-white"
                  : "text-slate-600 hover:bg-slate-200/60 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700/50 dark:hover:text-white",
              )}
            >
              {item}
            </Button>
          )
        })}
      </div>

      {overflow.right && <ScrollArrow side="right" onClick={() => scrollByPage(1)} />}
    </div>
  )
}
