import { render } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { ComparisonChart, type ComparisonRow, type EntitySeries } from "./comparison-charts"

/**
 * The column labels do not overwrite each other on a full panel.
 *
 * Recharts draws nothing in jsdom unless its container reports a size, so this
 * is the one suite that gives it one — a half-row card, the narrower of the
 * two widths a panel is drawn at and therefore the crowded case. It then reads
 * the laid-out label positions back and checks that no two overlap.
 *
 * This is the failure that prompted the labels to drop the currency mark: at
 * twelve columns across half a card, "₨247.6K" over one branch ran into
 * "₨132.2K" over the next. A character of padding is worth a test, because
 * nothing else in the suite can see it.
 */

/**
 * The narrowest a panel is ever drawn: the two-column grid opens at Tailwind's
 * `xl` (1280px), so a panel is at its most cramped on a 1280px laptop, not on
 * the wide screen the charts get demonstrated on. Roughly (1280 - sidebar -
 * page padding - gap) / 2, less the card's own padding.
 */
const CARD_WIDTH = 440
/** The same panel widened to the whole row, where the figures fit across. */
const FULL_CARD_WIDTH = 944
const CARD_HEIGHT = 300

let cardWidth = CARD_WIDTH

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  for (const prop of ["offsetWidth", "clientWidth"]) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => cardWidth })
  }
  for (const prop of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: CARD_HEIGHT })
  }
  HTMLElement.prototype.getBoundingClientRect = () => ({
    width: cardWidth, height: CARD_HEIGHT, top: 0, left: 0,
    bottom: CARD_HEIGHT, right: cardWidth, x: 0, y: 0, toJSON() {},
  }) as DOMRect
})

beforeEach(() => { cardWidth = CARD_WIDTH })

/**
 * A deliberately pessimistic advance per character, as a fraction of the font
 * size: real digits are nearer 0.57em and "." is half that, so a label that
 * clears this clears the drawn one with room over.
 */
const CHAR_ADVANCE_EM = 0.6

type Box = { text: string; left: number; right: number; top: number; bottom: number }

/**
 * The box a drawn figure occupies, upright or across.
 *
 * Across, it is centred on its column and sits on its baseline. Upright, it is
 * rotated about its own anchor and runs up from that baseline, so its length
 * and its height swap over — which is the whole point of turning it.
 */
function labelBoxes(container: HTMLElement): Box[] {
  return Array.from(container.querySelectorAll(".recharts-label-list text")).map((node) => {
    const text = node.textContent ?? ""
    const fontSize = Number.parseFloat((node as SVGTextElement).style.fontSize) || 11
    const length = text.length * fontSize * CHAR_ADVANCE_EM
    const x = Number(node.getAttribute("x"))
    const y = Number(node.getAttribute("y"))
    const rotated = (node.getAttribute("transform") ?? "").includes("rotate(-90")
    return rotated
      ? { text, left: x - fontSize / 2, right: x + fontSize / 2, top: y - length, bottom: y }
      : { text, left: x - length / 2, right: x + length / 2, top: y - fontSize, bottom: y }
  })
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function collisions(boxes: Box[]): string[] {
  const found: string[] = []
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlaps(boxes[i], boxes[j])) found.push(`${boxes[i].text.trim()} ↔ ${boxes[j].text.trim()}`)
    }
  }
  return found
}

const row = (over: Partial<ComparisonRow>): ComparisonRow => ({
  key: "k", label: "Entity", value: 0, previousValue: 0, changePct: null,
  spendCents: 0, quantity: 0, orderCount: 0, avgUnitPriceCents: 0,
  share: 0, cumulativeShare: 0, ...over,
})

const base = {
  series: [] as EntitySeries[], periods: [] as string[], format: "currency",
  metricLabel: "Procurement Value", unit: null, concentrationEligible: true, colorful: true,
}

describe("column labels on a half-row card", () => {
  // The branch panel as production draws it: ten branches, each with the
  // budget it was given beside what it consumed.
  const BRANCHES: Array<[string, number, number]> = [
    ["Karachi Central", 45_000_000, 24_760_000],
    ["Consumer & ADC Operations", 20_000_000, 13_220_000],
    ["Liberty Division", 25_000_000, 12_540_000],
    ["Lahore North", 29_000_000, 12_020_000],
    ["Lahore Division", 29_000_000, 7_660_000],
    ["Security Department", 10_000_000, 3_710_000],
    ["Islamabad Hub", 18_000_000, 1_470_000],
    ["ESG Division", 4_000_000, 1_030_000],
    ["Dispatch", 3_500_000, 910_000],
    ["Demo North Branch", 2_500_000, 460_000],
  ]

  it("keeps every branch's budget and value figure clear of its neighbours", () => {
    const rows = BRANCHES.map(([label, budget, value], index) => row({
      key: String(index), label, value, spendCents: value, totalBudgetCents: budget,
    }))
    const { container } = render(
      <ComparisonChart {...base} chart="column" rows={rows} dimensionLabel="Branch" dimension="branch" budgetBeside />,
    )
    const boxes = labelBoxes(container)
    // Every bar carries its figure: one per branch, plus one per budget.
    expect(boxes).toHaveLength(BRANCHES.length * 2)
    expect(collisions(boxes)).toEqual([])
  })

  it("separates the pair for a branch that has consumed almost all of its budget", () => {
    // The two column tops land within a few pixels of each other here, which
    // is the case the lift exists for — and the branch a reader is hunting.
    const rows = BRANCHES.map(([label], index) => row({
      key: String(index), label, value: 9_900_000, spendCents: 9_900_000, totalBudgetCents: 10_000_000,
    }))
    const { container } = render(
      <ComparisonChart {...base} chart="column" rows={rows} dimensionLabel="Branch" dimension="branch" budgetBeside />,
    )
    expect(collisions(labelBoxes(container))).toEqual([])
  })

  it("draws the figures across the columns, not upright, once the panel is widened", () => {
    // "Full width" is the room the reader asked for; spending it on upright
    // figures they did not ask for would make the checkbox pointless.
    cardWidth = FULL_CARD_WIDTH
    const rows = BRANCHES.map(([label, budget, value], index) => row({
      key: String(index), label, value, spendCents: value, totalBudgetCents: budget,
    }))
    const { container } = render(
      <ComparisonChart
        {...base} chart="column" rows={rows} dimensionLabel="Branch" dimension="branch" budgetBeside fullWidth
      />,
    )
    const upright = Array.from(container.querySelectorAll(".recharts-label-list text"))
      .filter((node) => (node.getAttribute("transform") ?? "").includes("rotate"))
    expect(upright).toHaveLength(0)
    expect(collisions(labelBoxes(container))).toEqual([])
  })

  it("keeps the two-line product labels clear at twelve columns", () => {
    const rows = Array.from({ length: 12 }, (_, index) => row({
      key: String(index),
      label: `Product number ${index + 1}`,
      value: 14_280_000 - index * 900_000,
      spendCents: 14_280_000 - index * 900_000,
      quantity: 1_240 - index * 80,
    }))
    const { container } = render(
      <ComparisonChart {...base} chart="column" rows={rows} dimensionLabel="Product" dimension="product" dualValueLabels />,
    )
    const boxes = labelBoxes(container)
    expect(boxes).toHaveLength(24)
    expect(collisions(boxes)).toEqual([])
  })
})
