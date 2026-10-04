"use client"

import * as React from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts"

import { utilizationPct, type ChartTypeId, type ExecutiveDimensionId } from "@/lib/executive-analytics"
import type { ExecutiveFilterState } from "./executive-filters"
import {
  AXIS_STYLE,
  BUDGET_BESIDE_COLOR,
  DataTable,
  GRID_STYLE,
  Legend,
  SERIES,
  VizTooltip,
  changeLabel,
  countShort,
  formatByKind,
  formatMarkLabelByKind,
  formatShortByKind,
  hoveredDatum,
  money,
  moneyShortBare,
  percent,
  type InjectedTooltipProps,
} from "./chart-kit"

/**
 * The chart renderers behind the Explore workbench.
 *
 * One component per form, all fed from the same rows, so switching form never
 * changes the numbers — only how they are drawn. The rules about which forms
 * are *offered* live in the registry (`chartTypesFor`) and are enforced on the
 * server; these components assume they are only asked to draw something the
 * registry already allowed.
 */

export type ComparisonRow = {
  key: string
  label: string
  value: number
  previousValue: number
  changePct: number | null
  spendCents: number
  quantity: number
  orderCount: number
  avgUnitPriceCents: number
  totalBudgetCents?: number
  consumedCents?: number
  remainingCents?: number
  share: number
  cumulativeShare: number
}

/**
 * One line per entity. `quantity` and `spendCents` ride along with the drawn
 * `value` so a point can be read as both; absent from an older response.
 */
export type EntitySeries = {
  key: string
  label: string
  points: Array<{ period: string; value: number; quantity?: number; spendCents?: number }>
}

/**
 * What a reader clicked: the entity, and — on a trend — the bucket as well.
 *
 * Both travel to the detail table, because a point on "requesters over months"
 * names a person *and* a month, and a table showing that person across the
 * whole window would not be the rows behind the point that was clicked.
 */
export type DrillTarget = {
  dimension: ExecutiveDimensionId
  key: string
  label: string
  /** "YYYY-MM" or "YYYY-MM-DD" when the click also named a bucket. */
  period?: string
  /**
   * A second entity the click named, as a narrowing of the shared filters.
   *
   * A cell of the requester × product grid is one person *and* one product;
   * the person travels as the key and the product overrides the screen's
   * product focus for this one request, so the table shows that pair and not
   * the person across every focused product. Only filters the server already
   * applies can be named here — there is no new parameter to audit.
   */
  narrow?: Partial<Pick<ExecutiveFilterState, "productIds" | "userIds" | "categoryIds" | "branchIds">>
}

type ChartProps = {
  chart: ChartTypeId
  rows: ComparisonRow[]
  series: EntitySeries[]
  periods: string[]
  format: string
  metricLabel: string
  dimensionLabel: string
  unit: string | null
  concentrationEligible: boolean
  /**
   * A distinct hue per entity.
   *
   * Colour is decoration here, never the encoding: every bar keeps its own axis
   * label and its own direct value label, so a repeated hue past the sixth slot
   * costs a reader nothing. On a time axis it is off, because months are a
   * sequence and colouring them at random would imply a grouping that is not
   * there.
   */
  colorful?: boolean
  /** Opens the detail table for the clicked bar, slice or point. */
  onDrillDown?: (target: DrillTarget) => void
  /** The dimension being compared, carried into the drill target. */
  dimension?: ExecutiveDimensionId
  /**
   * Each row carries its entity's Total Budget beside its figure — the
   * `/compare` response answered `budget=1`. The column form then draws the
   * budget as a second column in the track colour, and the tooltip and table
   * read it out. Explicit rather than inferred from `totalBudgetCents`, because
   * the budget *metrics* also fill that field, on rows whose figure *is* the
   * budget position; a companion budget on a spend row is a different thing.
   */
  budgetBeside?: boolean
  /**
   * Each column carries both of its figures above it — quantity on top, value
   * below — instead of the single drawn measure.
   *
   * Set by the registry, for the panels where the reader is comparing the two
   * against each other. It only changes what is *printed*: the column's height
   * is still the selected measure, and the tooltip and the table are unchanged.
   */
  dualValueLabels?: boolean
  /**
   * The panel spans the whole row rather than half of it.
   *
   * The only thing this changes is whether the figures over the columns have
   * room to be drawn across them. A panel cannot measure itself — its width
   * lives inside the `ResponsiveContainer` — but it does know which of the two
   * shapes the reader put it in, and that is the larger half of the answer.
   */
  fullWidth?: boolean
}

/** The figure as a share of the budget beside it, or the reason there is none. */
export function budgetShareLabel(valueCents: number, totalBudgetCents: number | undefined): string {
  if (!totalBudgetCents || totalBudgetCents <= 0) return "no budget"
  return percent(utilizationPct(valueCents, totalBudgetCents))
}

/** Long labels need vertical room; short lists should not stretch to fill. */
const rankHeight = (count: number) => Math.max(220, Math.min(560, count * 34 + 48))

/** The hue for one entity's slot, cycling once the fixed palette is exhausted. */
export function entityColor(index: number, colorful?: boolean): string {
  return colorful ? SERIES[index % SERIES.length] : SERIES[0]
}

/** Reads a Recharts click payload back into a row, whatever shape it arrives in. */
function rowFromPayload(entry: any): ComparisonRow | null {
  const row = entry?.payload?.payload ?? entry?.payload ?? entry
  return row && typeof row.key === "string" ? (row as ComparisonRow) : null
}

/**
 * The shared "clicking this opens the rows behind it" affordance.
 *
 * Kept as one helper rather than repeated per chart so every form drills the
 * same way — a reader who learns it on the bars does not have to rediscover it
 * on the donut.
 */
function drillHandler(
  dimension: ExecutiveDimensionId | undefined,
  onDrillDown: ((target: DrillTarget) => void) | undefined,
) {
  if (!dimension || !onDrillDown) return undefined
  return (entry: any) => {
    const row = rowFromPayload(entry)
    if (row) onDrillDown({ dimension, key: row.key, label: row.label })
  }
}

/** Footnote telling the reader the chart is drillable, shown only when it is. */
export function DrillHint({ enabled, noun }: Readonly<{ enabled: boolean; noun: string }>) {
  if (!enabled) return null
  return (
    <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
      Select any {noun} to open the order lines behind it, for this same period and these same filters.
    </p>
  )
}

function EntityTooltip({
  format, metricLabel, concentrationEligible, showChange, budgetBeside, ...injected
}: InjectedTooltipProps<ComparisonRow> & Readonly<{
  format: string
  metricLabel: string
  concentrationEligible: boolean
  showChange: boolean
  budgetBeside?: boolean
}>) {
  const row = hoveredDatum(injected)
  if (!row) return null
  const rows = [
    { label: metricLabel, value: formatByKind(row.value, format), color: SERIES[0] },
    ...(concentrationEligible ? [{ label: "Share of shown", value: percent(row.share) }] : []),
    ...(showChange ? [{ label: "vs prior period", value: changeLabel(row.changePct).text }] : []),
  ]

  // A companion budget first: the row's figure is the selected money metric,
  // and the budget is what it is read against. The `totalBudgetCents` test
  // below is for the budget metrics, where the figure *is* the position.
  if (budgetBeside) {
    rows.push(
      { label: "Quantity", value: countShort(row.quantity) } as any,
      { label: "Total budget", value: money(row.totalBudgetCents ?? 0), color: BUDGET_BESIDE_COLOR } as any,
      { label: "% of budget", value: budgetShareLabel(row.value, row.totalBudgetCents), muted: true } as any,
      { label: "Orders", value: countShort(row.orderCount), muted: true } as any,
    )
  } else if (row.totalBudgetCents !== undefined) {
    rows.push(
      { label: "Total budget", value: money(row.totalBudgetCents), muted: true } as any,
      { label: "Consumed", value: money(row.consumedCents ?? 0), muted: true } as any,
      { label: "Remaining", value: money(row.remainingCents ?? 0), muted: true } as any,
    )
  } else {
    // Both figures, whichever one the bar is drawn from.
    if (format !== "quantity") rows.push({ label: "Quantity", value: countShort(row.quantity) } as any)
    rows.push(
      { label: metricLabel === "Consumed" ? "Consumed" : "Procurement value", value: money(row.spendCents), muted: format !== "quantity" } as any,
      { label: "Orders", value: countShort(row.orderCount), muted: true } as any,
    )
  }

  return <VizTooltip title={row.label} rows={rows as any} />
}

export function ComparisonChart(props: Readonly<ChartProps>) {
  switch (props.chart) {
    case "column": return <ColumnChart {...props} />
    case "grouped": return <GroupedChart {...props} />
    case "donut": return <DonutChart {...props} />
    case "line": return <TrendChart {...props} />
    case "scatter": return <ScatterCompare {...props} />
    case "table": return <ComparisonTable {...props} />
    default: return <RankedBars {...props} />
  }
}

// ── Ranked bars — the default ──────────────────────────────────────────────

function RankedBars({
  rows, format, metricLabel, colorful, dimension, onDrillDown, dimensionLabel,
}: Readonly<ChartProps>) {
  const drill = drillHandler(dimension, onDrillDown)
  return (
    <>
      <ResponsiveContainer width="100%" height={rankHeight(rows.length)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 84, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(value) => formatShortByKind(value, format)}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
          />
          <YAxis type="category" dataKey="label" width={168} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={<EntityTooltip format={format} metricLabel={metricLabel} concentrationEligible showChange />}
          />
          <Bar
            dataKey="value"
            fill={SERIES[0]}
            radius={[0, 4, 4, 0]}
            barSize={18}
            isAnimationActive={false}
            // Selecting a bar opens the rows behind it. Adding an entity to the
            // comparison is the "Which ones" picker's job — one click cannot
            // mean two things, and the rows are what a reader wants first.
            onClick={drill}
            className={drill ? "cursor-pointer" : undefined}
          >
            {rows.map((row, index) => (
              <Cell key={row.key} fill={entityColor(index, colorful)} />
            ))}
            {/* Direct labels: the relief rule for the low-contrast light slots. */}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(value: any) => formatMarkLabelByKind(Number(value), format)}
              style={{ fontSize: 11, fill: "var(--viz-ink)", fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {colorful
        ? <Legend items={rows.slice(0, 12).map((row, index) => ({ key: row.key, label: row.label, color: entityColor(index, true) }))} />
        : <Legend items={[{ label: metricLabel, color: SERIES[0] }]} />}
      <DrillHint enabled={Boolean(drill)} noun={dimensionLabel.toLowerCase()} />
    </>
  )
}

// ── Columns ────────────────────────────────────────────────────────────────

/**
 * Past either of these an upright tick collides with its neighbour: twelve
 * product names across half a row leave each column about sixty pixels, and a
 * name like "Tapal Danedar Teabags (600 PCS)" is three times that on its own.
 */
const COLUMN_UPRIGHT_MAX_COLUMNS = 6
const COLUMN_UPRIGHT_MAX_CHARS = 18
/**
 * The longest an angled tick is drawn. The tick only has to tell the columns
 * apart — the full name is in the tooltip, the legend and the table.
 */
const COLUMN_TICK_MAX_CHARS = 22

/** Whether the x-axis ticks are angled rather than upright, for these rows. */
export function columnTicksAngled(rows: ReadonlyArray<Pick<ComparisonRow, "label">>): boolean {
  return rows.length > COLUMN_UPRIGHT_MAX_COLUMNS
    || rows.some((entry) => entry.label.length > COLUMN_UPRIGHT_MAX_CHARS)
}

/** The tick text for one angled column: the label, shortened with an ellipsis past the cap. */
export function columnTickLabel(label: unknown): string {
  const text = String(label ?? "")
  if (text.length <= COLUMN_TICK_MAX_CHARS) return text
  return `${text.slice(0, COLUMN_TICK_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * The category axis of every upright column chart, upright or angled.
 *
 * Spread onto a Recharts `XAxis` rather than wrapped in a component of its
 * own: Recharts finds its axes by element type, so a wrapper would hide the
 * axis from it. The chart height and bottom margin that go with the angled
 * form are `columnChartHeight` and `columnBottomMargin`.
 */
export function columnAxisProps(angled: boolean) {
  return {
    tick: AXIS_STYLE,
    axisLine: false,
    tickLine: false,
    interval: 0 as const,
    angle: angled ? -45 : 0,
    textAnchor: (angled ? "end" : "middle") as "end" | "middle",
    height: angled ? 104 : 30,
    tickFormatter: angled ? columnTickLabel : undefined,
  }
}

/**
 * The two figures a dual column label prints, in the order they are read.
 *
 * Both come off the row, never off the drawn value: a line-grain row carries
 * its quantity and its value whichever measure is selected, so flipping
 * Amount ⇄ Quantity changes which of the two the column's *height* is and
 * never which two are printed. Quantity leads.
 *
 * The currency mark is dropped here, as it is on every figure drawn on a
 * column. The axis, the tooltip, the table and the caption below the chart all
 * still carry it.
 */
export function dualColumnLabelLines(
  row: Pick<ComparisonRow, "quantity" | "spendCents">,
): { quantity: string; money: string } {
  return { quantity: countShort(row.quantity), money: moneyShortBare(row.spendCents) }
}

/** The measure the column is drawn from leads; the figure beside it is muted. */
const LABEL_MEASURED = { fontSize: 11, fill: "var(--viz-ink)", fontWeight: 700 } as const
const LABEL_COMPANION = { fontSize: 10, fill: "var(--viz-axis)", fontWeight: 600 } as const
/** A reference figure is never the subject, so it never takes the leading ink. */
const LABEL_REFERENCE = { fontSize: 11, fill: "var(--viz-axis)", fontWeight: 600 } as const
/** Both figures as one upright string: one size, each half in its own ink. */
const LABEL_COMBINED = { fontSize: 10, fill: "var(--viz-ink)", fontWeight: 600 } as const

/**
 * Quantity and value as one upright string, "12 · 142.8K", for a column too
 * narrow to stand two lines beside it. The measure the column is drawn from
 * keeps the leading ink; the other half takes the companion's.
 */
export function CombinedFigure({ x, y, quantity, money: value, format }: Readonly<{
  x: number
  y: number
  quantity: string
  money: string
  format: string
}>) {
  const quantityIsMeasured = format !== "currency"
  const ink = (measured: boolean) => (measured
    ? { fill: LABEL_MEASURED.fill, fontWeight: LABEL_MEASURED.fontWeight }
    : { fill: LABEL_COMPANION.fill, fontWeight: LABEL_COMPANION.fontWeight })
  return (
    <ColumnFigure x={x} y={y} rotated style={LABEL_COMBINED}>
      <tspan style={ink(quantityIsMeasured)}>{quantity}</tspan>
      <tspan style={ink(!quantityIsMeasured)}>{` · ${value}`}</tspan>
    </ColumnFigure>
  )
}

/**
 * Past this many columns a figure drawn across the column is wider than the
 * column itself, and neighbouring figures start overwriting each other.
 *
 * At the narrowest a panel is drawn — half of a 1280px window, which is where
 * the two-column grid opens — the plot is about 350px, so seven columns leave
 * fifty pixels each and a figure like "142.8K" wants forty. Past that the
 * figures are turned to read upward instead, where each one costs its font
 * size in width rather than its length. Width-independent, like the rule that
 * angles the ticks below them: a panel cannot measure itself, and the
 * narrowest case is the one that has to be right.
 */
const COLUMN_LABEL_UPRIGHT_MAX = 6

/** The same rule across the whole row, where there is twice the width to spend. */
const COLUMN_LABEL_UPRIGHT_MAX_FULL_WIDTH = 12

/** Whether the figures over the columns read upward rather than across. */
export function columnLabelsRotated(columns: number, fullWidth?: boolean): boolean {
  return columns > (fullWidth ? COLUMN_LABEL_UPRIGHT_MAX_FULL_WIDTH : COLUMN_LABEL_UPRIGHT_MAX)
}

/**
 * How far a figure steps off its column's centre, to clear the one beside it.
 *
 * An upright figure is as wide as its type, and the two columns of a budget
 * pair stand about ten pixels apart at the narrowest a panel is drawn — close
 * enough that the two figures shave each other wherever the branch's budget
 * and its spend come out at a similar height. A few pixels outward each gives
 * them their width back, and a figure nudged three pixels is still plainly
 * over its own column, which is eleven wide.
 *
 * Zero unless the figures are upright *and* there are two of them: across, a
 * pair is kept apart by `budgetLabelY` lifting one onto its own line instead.
 */
export function columnLabelNudge(rotated: boolean, budgetBeside?: boolean): number {
  return rotated && budgetBeside ? 3 : 0
}

/**
 * One figure over one column, across or reading upward.
 *
 * Rotating about the anchor keeps the same (x, y) meaning either way — the
 * centre of the column, and the baseline the caller chose — so every caller
 * positions in one coordinate system and this decides how the glyphs sit in
 * it.
 */
function ColumnFigure({ x, y, rotated, style, children }: Readonly<{
  x: number
  y: number
  rotated: boolean
  style: Record<string, unknown>
  children: React.ReactNode
}>) {
  if (!rotated) {
    return <text x={x} y={y} textAnchor="middle" style={style}>{children}</text>
  }
  return (
    <text
      x={x}
      y={y}
      textAnchor="start"
      dominantBaseline="central"
      transform={`rotate(-90 ${x} ${y})`}
      style={style}
    >
      {children}
    </text>
  )
}

/** Baselines for the two lines of a dual label, measured up from the column. */
const DUAL_LABEL_TOP_LINE = 19
const DUAL_LABEL_BOTTOM_LINE = 5
/** How far apart the two lines sit once turned upright. */
const DUAL_LABEL_GAP = 14
/** Two stacked lines need more headroom above the tallest column than one does. */
const DUAL_LABEL_TOP_MARGIN = 36
/** …and a budget figure lifted clear over the pair needs one line more. */
const DUAL_BUDGET_LABEL_TOP_MARGIN = 50
/** An upright figure stands on its length: six or seven characters of it. */
const ROTATED_LABEL_TOP_MARGIN = 56
/** Both figures as one upright string, "1.2K · 142.8K", stand on twice that. */
const ROTATED_COMBINED_LABEL_TOP_MARGIN = 88

/**
 * The `LabelList` content that draws them.
 *
 * Recharts hands a label its own `viewBox` and its index, not the row, so the
 * rows are closed over and read back by index — the same array the chart was
 * given, in the same order.
 *
 * Turned upright the two figures become one string rather than two lines:
 * two parallel lines up the side of a column read as two unrelated numbers,
 * where "12 · 142.8K" read bottom-to-top keeps the quantity first, which is
 * the order the reader was promised.
 */
export function dualColumnLabel(
  rows: ReadonlyArray<Pick<ComparisonRow, "quantity" | "spendCents"> | null | undefined>,
  format: string,
  rotated: boolean,
  options?: Readonly<{ combined?: boolean; nudge?: number }>,
) {
  const quantityIsMeasured = format !== "currency"
  const quantityStyle = quantityIsMeasured ? LABEL_MEASURED : LABEL_COMPANION
  const moneyStyle = quantityIsMeasured ? LABEL_COMPANION : LABEL_MEASURED
  return function DualColumnLabel(props: any) {
    const row = rows[Number(props?.index)]
    const box = props?.viewBox ?? props
    const x = Number(box?.x)
    const y = Number(box?.y)
    const width = Number(box?.width)
    if (!row || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width)) return <g />

    const lines = dualColumnLabelLines(row)
    const centre = x + width / 2 + (options?.nudge ?? 0)
    // Beside a budget column there is room for one upright line, not two:
    // the pair is printed as one string, quantity first.
    if (rotated && options?.combined) {
      return <CombinedFigure x={centre} y={y - COLUMN_LABEL_OFFSET} quantity={lines.quantity} money={lines.money} format={format} />
    }
    // Turned upright the pair becomes two parallel lines rather than two
    // stacked ones: the same design rotated, so the quantity that led above
    // the column leads to the left of it.
    const quantityAt = rotated
      ? { x: centre - DUAL_LABEL_GAP / 2, y: y - COLUMN_LABEL_OFFSET }
      : { x: centre, y: y - DUAL_LABEL_TOP_LINE }
    const moneyAt = rotated
      ? { x: centre + DUAL_LABEL_GAP / 2, y: y - COLUMN_LABEL_OFFSET }
      : { x: centre, y: y - DUAL_LABEL_BOTTOM_LINE }
    return (
      <g>
        <ColumnFigure {...quantityAt} rotated={rotated} style={quantityStyle}>{lines.quantity}</ColumnFigure>
        <ColumnFigure {...moneyAt} rotated={rotated} style={moneyStyle}>{lines.money}</ColumnFigure>
      </g>
    )
  }
}

/** The figure over an ordinary column: the measure the column is drawn from. */
export function columnValueLabel(
  rows: ReadonlyArray<ComparisonRow>,
  format: string,
  rotated: boolean,
  nudge = 0,
) {
  return function ColumnValueLabel(props: any) {
    const box = props?.viewBox ?? props
    const x = Number(box?.x)
    const y = Number(box?.y)
    const width = Number(box?.width)
    const value = Number(props?.value)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(value)) {
      return <g />
    }
    return (
      <ColumnFigure x={x + width / 2 + nudge} y={y - COLUMN_LABEL_OFFSET} rotated={rotated} style={LABEL_MEASURED}>
        {formatMarkLabelByKind(value, format)}
      </ColumnFigure>
    )
  }
}

/** Angled ticks need more of the card; the plot keeps its height either way. */
export const columnChartHeight = (angled: boolean, upright: number) => (angled ? upright + 40 : upright)
export const columnBottomMargin = (angled: boolean) => (angled ? 8 : 12)

/**
 * Headroom over the tallest column: enough for whichever label form it carries.
 *
 * An upright figure stands on its length rather than its height, so it needs
 * far more of it — and the card grows by the difference rather than the plot
 * shrinking into it, which would flatten every column to buy room for a label.
 */
export function columnTopMargin(options: Readonly<{
  dual: boolean
  budgetBeside?: boolean
  rotated: boolean
  /** Upright figures printed as one "quantity · value" string. */
  combined?: boolean
}>): number {
  if (options.rotated) return options.combined ? ROTATED_COMBINED_LABEL_TOP_MARGIN : ROTATED_LABEL_TOP_MARGIN
  if (options.dual) return options.budgetBeside ? DUAL_BUDGET_LABEL_TOP_MARGIN : DUAL_LABEL_TOP_MARGIN
  return options.budgetBeside ? BUDGET_LABEL_TOP_MARGIN : 20
}

/**
 * The Total Budget printed over its own column, or nothing when there is none.
 *
 * An entity with no budget has no column to label, and a "0" drawn at the
 * baseline would sit on top of the axis ticks. The tooltip and the table say
 * "no budget" in words, which is the honest answer rather than a zero.
 */
export function budgetColumnLabel(value: unknown): string {
  const cents = Number(value)
  if (!Number.isFinite(cents) || cents <= 0) return ""
  return moneyShortBare(cents)
}

/** How far a column label floats above its column, and the line it clears by. */
const COLUMN_LABEL_OFFSET = 5
/**
 * Comfortably more than the line an 11px figure occupies: a lift of exactly a
 * line height leaves the two labels touching, not clear of each other.
 */
const COLUMN_LABEL_LINE = 15
/** A budget beside the column may lift its label by a line; leave room for it. */
const BUDGET_LABEL_TOP_MARGIN = 32

/**
 * The baseline for the Total Budget figure, given the column beside it.
 *
 * Both figures would otherwise float the same few pixels over their own
 * column, so a branch that has consumed nearly its whole budget prints them on
 * top of each other — and that is precisely the branch the panel exists to
 * surface. When the two would land within a line of each other, the budget is
 * lifted clear: it is the reference, so it is the one that moves, and it moves
 * the same way whether the branch is just under its budget or just over it.
 *
 * `valueLines` is how many lines the value column's label stands on — two when
 * it carries both quantity and value — so the budget clears the whole block,
 * landing a line above its top line.
 */
export function budgetLabelY(budgetTop: number, valueTop: number, valueLines = 1): number {
  const natural = budgetTop - COLUMN_LABEL_OFFSET
  const valueLowest = valueTop - COLUMN_LABEL_OFFSET
  const valueHighest = valueLowest - (Math.max(1, valueLines) - 1) * (DUAL_LABEL_TOP_LINE - DUAL_LABEL_BOTTOM_LINE)
  if (natural >= valueLowest + COLUMN_LABEL_LINE || natural <= valueHighest - COLUMN_LABEL_LINE) return natural
  return valueHighest - COLUMN_LABEL_LINE
}

/**
 * The `LabelList` content for the Total Budget column.
 *
 * The value column's top is derived from the budget column's own geometry
 * rather than read from the chart: both columns stand on the same baseline and
 * share one axis that starts at zero, so the budget column's height *is* the
 * scale. That is cheaper and steadier than reaching for Recharts internals,
 * and it degrades to the natural position if the column has not been measured.
 */
export function budgetColumnLabelContent(
  rows: ReadonlyArray<ComparisonRow>,
  rotated: boolean,
  nudge = 0,
  valueLines = 1,
) {
  return function BudgetColumnLabel(props: any) {
    const row = rows[Number(props?.index)]
    const box = props?.viewBox ?? props
    const x = Number(box?.x)
    const y = Number(box?.y)
    const width = Number(box?.width)
    const height = Number(box?.height)
    const text = budgetColumnLabel(row?.totalBudgetCents)
    if (!text || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width)) return <g />

    // Upright, the two figures already stand apart on their own columns' x, so
    // the lift is only for the case where they share a line.
    const budgetCents = Number(row.totalBudgetCents)
    const liftable = !rotated && Number.isFinite(height) && height > 0 && budgetCents > 0
    const valueTop = liftable ? (y + height) - (row.value * (height / budgetCents)) : y
    return (
      <ColumnFigure
        x={x + width / 2 - nudge}
        y={liftable ? budgetLabelY(y, valueTop, valueLines) : y - COLUMN_LABEL_OFFSET}
        rotated={rotated}
        style={LABEL_REFERENCE}
      >
        {text}
      </ColumnFigure>
    )
  }
}

/**
 * How the figures over a column chart are laid out.
 *
 * Beside a budget, the quantity-and-value pair labels the value column alone
 * and the budget column keeps its one figure. Upright, there is room over a
 * budget pair for one line per column, so the value's two figures become one
 * string; across, the budget figure clears both of the pair's lines.
 */
function columnLabelLayout(
  rows: ReadonlyArray<ComparisonRow>,
  format: string,
  options: Readonly<Pick<ChartProps, "dualValueLabels" | "budgetBeside" | "fullWidth">>,
) {
  const dual = Boolean(options.dualValueLabels)
  const rotated = columnLabelsRotated(rows.length, options.fullWidth)
  const combined = dual && Boolean(options.budgetBeside) && rotated
  const nudge = columnLabelNudge(rotated, options.budgetBeside)
  return {
    dual,
    rotated,
    nudge,
    topMargin: columnTopMargin({ dual, budgetBeside: options.budgetBeside, rotated, combined }),
    valueLabel: dual
      ? dualColumnLabel(rows, format, rotated, { combined, nudge: combined ? nudge : 0 })
      : columnValueLabel(rows, format, rotated, nudge),
    budgetValueLines: dual ? 2 : 1,
  }
}

/**
 * Upright columns, one per entity — and, with a budget beside, two: the
 * entity's Total Budget in the reference hue and its figure in its own,
 * standing apart rather than stacked, because "how much was given against how
 * much was used" is the comparison the reader is making. Same form as the
 * Overview's Budget vs Consumed chart, so the two read alike.
 *
 * Every column carries its own figure. Which way up they are drawn, and how
 * far the card grows to hold them, is `columnLabelsRotated` and
 * `columnTopMargin` — twelve figures across a half-row panel do not fit
 * lying down.
 */
function ColumnChart({
  rows, format, metricLabel, colorful, dimension, onDrillDown, dimensionLabel, budgetBeside, dualValueLabels,
  fullWidth,
}: Readonly<ChartProps>) {
  const angled = columnTicksAngled(rows)
  const drill = drillHandler(dimension, onDrillDown)
  const { dual, rotated, nudge, topMargin, valueLabel, budgetValueLines } = columnLabelLayout(rows, format, {
    dualValueLabels, budgetBeside, fullWidth,
  })
  return (
    <>
      {/* The card grows for the labels rather than the plot shrinking for them. */}
      <ResponsiveContainer width="100%" height={columnChartHeight(angled, 300) + topMargin - 20}>
        <BarChart
          data={rows}
          margin={{ top: topMargin, right: 12, bottom: columnBottomMargin(angled), left: 4 }}
          barCategoryGap={budgetBeside ? "24%" : undefined}
          barGap={budgetBeside ? 3 : undefined}
        >
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis dataKey="label" {...columnAxisProps(angled)} />
          <YAxis
            tickFormatter={(value) => formatShortByKind(value, format)}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            width={72}
          />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={(
              <EntityTooltip
                format={format}
                metricLabel={metricLabel}
                concentrationEligible
                showChange
                budgetBeside={budgetBeside}
              />
            )}
          />
          {budgetBeside ? (
            <Bar
              dataKey="totalBudgetCents"
              name="Total budget"
              fill={BUDGET_BESIDE_COLOR}
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
              isAnimationActive={false}
              onClick={drill}
              className={drill ? "cursor-pointer" : undefined}
            >
              {/*
                The reference column carries its own figure, like the one
                beside it — in the muted text token rather than its own fill,
                because a value is text and the column under it is what says
                which quantity it belongs to.
              */}
              <LabelList
                dataKey="totalBudgetCents"
                position="top"
                content={budgetColumnLabelContent(rows, rotated, nudge, budgetValueLines)}
              />
            </Bar>
          ) : null}
          <Bar
            dataKey="value"
            fill={SERIES[0]}
            radius={[4, 4, 0, 0]}
            maxBarSize={budgetBeside ? 40 : 56}
            isAnimationActive={false}
            onClick={drill}
            className={drill ? "cursor-pointer" : undefined}
          >
            {rows.map((row, index) => (
              <Cell key={row.key} fill={entityColor(index, colorful)} />
            ))}
            <LabelList
              dataKey="value"
              position="top"
              content={valueLabel}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <Legend
        items={[
          ...(budgetBeside ? [{ key: "total-budget", label: "Total budget", color: BUDGET_BESIDE_COLOR }] : []),
          ...(colorful
            ? rows.slice(0, 12).map((row, index) => ({ key: row.key, label: row.label, color: entityColor(index, true) }))
            : [{ label: metricLabel, color: SERIES[0] }]),
        ]}
      />
      <DrillHint enabled={Boolean(drill)} noun={dimensionLabel.toLowerCase()} />
      {dual ? <DualLabelNote metricLabel={metricLabel} rotated={rotated} budgetBeside={budgetBeside} /> : null}
      {budgetBeside ? (
        <BudgetBesideNote metricLabel={metricLabel} />
      ) : null}
    </>
  )
}

/** How to read the two figures over a column, and — beside a budget — which column carries which. */
function DualLabelNote({ metricLabel, rotated, budgetBeside }: Readonly<{
  metricLabel: string
  rotated: boolean
  budgetBeside?: boolean
}>) {
  const order = rotated ? "before" : "above"
  const copy = budgetBeside
    ? `Each ${metricLabel.toLowerCase()} column is labelled with its quantity ${order} its value in ₨; the Total budget column beside it carries the budget.`
    : `Each column is labelled with its quantity ${order} its value in ₨, whichever measure the columns are drawn from.`
  return (
    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
      {copy} Values are abbreviated; the exact figures are in the tooltip and the table.
    </p>
  )
}

function BudgetBesideNote({ metricLabel }: Readonly<{ metricLabel: string }>) {
  const copy = metricLabel === "Consumed"
    ? "Total budget is allocated + add-ons for every month in the period. Consumed includes orders awaiting approval and excludes cancelled, rejected, and refunded orders."
    : `Total budget is allocated + add-ons for every month in the period. ${metricLabel} excludes pending orders, so its share of budget reads lower than the Overview's Utilization, which counts them.`
  return <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{copy}</p>
}

// ── This period vs prior ───────────────────────────────────────────────────

function PeriodPairTooltip({ format, ...injected }: InjectedTooltipProps<ComparisonRow> & Readonly<{ format: string }>) {
  const row = hoveredDatum(injected)
  if (!row) return null
  return (
    <VizTooltip
      title={row.label}
      rows={[
        { label: "This period", value: formatByKind(row.value, format), color: SERIES[0] },
        { label: "Prior period", value: formatByKind(row.previousValue, format), color: SERIES[1] },
        { label: "Change", value: changeLabel(row.changePct).text },
      ]}
    />
  )
}

function GroupedChart({ rows, format, metricLabel }: Readonly<ChartProps>) {
  return (
    <>
      <ResponsiveContainer width="100%" height={rankHeight(rows.length * 1.4)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 84, bottom: 4, left: 4 }} barGap={2}>
          <CartesianGrid {...GRID_STYLE} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(value) => formatShortByKind(value, format)}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
          />
          <YAxis type="category" dataKey="label" width={168} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={<PeriodPairTooltip format={format} />}
          />
          <Bar dataKey="previousValue" fill={SERIES[1]} radius={[0, 4, 4, 0]} barSize={9} />
          <Bar dataKey="value" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={9}>
            <LabelList
              dataKey="value"
              position="right"
              formatter={(value: any) => formatMarkLabelByKind(Number(value), format)}
              style={{ fontSize: 11, fill: "var(--viz-ink)", fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <Legend items={[
        { label: `${metricLabel}, this period`, color: SERIES[0] },
        { label: "Prior period", color: SERIES[1] },
      ]} />
    </>
  )
}

// ── Share of total ─────────────────────────────────────────────────────────

function ShareTooltip({ format, metricLabel, ...injected }: InjectedTooltipProps<ComparisonRow> & Readonly<{
  format: string
  metricLabel: string
}>) {
  const row = hoveredDatum(injected)
  if (!row) return null
  return (
    <VizTooltip
      title={row.label}
      rows={[
        { label: metricLabel, value: formatByKind(row.value, format) },
        { label: "Share of shown", value: percent(row.share) },
        { label: "vs prior period", value: changeLabel(row.changePct).text, muted: true },
      ]}
    />
  )
}

function DonutChart({ rows, format, metricLabel, dimensionLabel, dimension, onDrillDown }: Readonly<ChartProps>) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0)
  const drill = drillHandler(dimension, onDrillDown)
  return (
    <>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Tooltip
            content={<ShareTooltip format={format} metricLabel={metricLabel} />}
          />
          <Pie
            data={rows}
            dataKey="value"
            nameKey="label"
            innerRadius="52%"
            outerRadius="80%"
            paddingAngle={2}
            stroke="var(--viz-surface)"
            strokeWidth={2}
            isAnimationActive={false}
            onClick={drill}
            className={drill ? "cursor-pointer" : undefined}
            label={({ payload, percent: fraction }: any) =>
              fraction > 0.04 ? `${payload.label} ${(fraction * 100).toFixed(0)}%` : ""}
            labelLine={false}
          >
            {rows.map((row, index) => (
              <Cell key={row.key} fill={SERIES[index % SERIES.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <Legend items={rows.map((row, index) => ({ key: row.key, label: row.label, color: SERIES[index % SERIES.length] }))} />
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Shares are of the {rows.length} {dimensionLabel.toLowerCase()} shown, totalling {formatByKind(total, format)} —
        not of everything in the period.
      </p>
      <DrillHint enabled={Boolean(drill)} noun="slice" />
    </>
  )
}

// ── Trend over time ────────────────────────────────────────────────────────

/**
 * A line-chart dot with its own hit area.
 *
 * Recharts hands a custom `dot` element the row it is drawn from, which is the
 * only reliable way to know *both* which line and which bucket a click landed
 * on. The visible dot stays small for legibility while an invisible circle
 * around it gives a target big enough to hit on a touch screen.
 */
function DrillDot({ cx, cy, color, payload, onDrill }: Readonly<{
  cx?: number
  cy?: number
  color?: string
  payload?: { period?: string }
  onDrill?: (period: string) => void
}>) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  return (
    <g>
      <circle cx={cx} cy={cy} r={3} fill={color} stroke="var(--viz-surface)" strokeWidth={1} pointerEvents="none" />
      {onDrill ? (
        <circle
          cx={cx}
          cy={cy}
          r={11}
          fill="transparent"
          className="cursor-pointer"
          onClick={() => onDrill(String(payload?.period ?? ""))}
        />
      ) : null}
    </g>
  )
}

/**
 * One line's figure in the trend tooltip: quantity and amount together when
 * the point carries both, whichever one the line is drawn from — otherwise the
 * drawn value alone, for a response that predates them or a metric that is
 * neither.
 */
export function trendPointLabel(
  point: EntitySeries["points"][number] | undefined,
  drawn: number,
  format: string,
): string {
  const carriesBoth = typeof point?.quantity === "number" && typeof point?.spendCents === "number"
  if (!carriesBoth || (format !== "currency" && format !== "quantity")) return formatByKind(drawn, format)
  return `Qty ${countShort(point?.quantity ?? 0)} · ${money(point?.spendCents ?? 0)}`
}

function TrendTooltip({ series, format, ...injected }: InjectedTooltipProps<unknown> & Readonly<{
  series: EntitySeries[]
  format: string
}>) {
  const { active, payload, label } = injected
  if (!active || !payload?.length) return null
  return (
    <VizTooltip
      title={String(label)}
      rows={series.map((entity, index) => ({
        label: entity.label,
        value: trendPointLabel(
          entity.points.find((point) => point.period === label),
          Number(payload.find((entry) => entry.dataKey === entity.key)?.value ?? 0),
          format,
        ),
        color: SERIES[index % SERIES.length],
      }))}
    />
  )
}

function TrendChart({
  series, periods, format, metricLabel, dimension, onDrillDown, dimensionLabel,
}: Readonly<ChartProps>) {
  /**
   * A point on a trend can name one thing or two.
   *
   * On a time axis the series *is* the period, so the bucket is the entity and
   * it drills as one. On "requesters over months" the point names a person and
   * a month, so both travel and the table shows that person in that month —
   * anything else would show rows the clicked point does not account for.
   */
  const isTimeAxis = dimension === "month" || dimension === "day"
  const drillPoint = dimension && onDrillDown
    ? (entity: EntitySeries, period: string) => {
      if (!period) return
      if (isTimeAxis) onDrillDown({ dimension, key: period, label: period })
      else onDrillDown({ dimension, key: entity.key, label: `${entity.label} · ${period}`, period })
    }
    : undefined

  // One row per period, one column per entity: the shape Recharts draws lines from.
  const data = periods.map((period, index) => {
    const point: Record<string, string | number> = { period }
    series.forEach((entity) => { point[entity.key] = entity.points[index]?.value ?? 0 })
    return point
  })

  return (
    <>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis dataKey="period" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            tickFormatter={(value) => formatShortByKind(value, format)}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            width={72}
          />
          <Tooltip
            cursor={{ stroke: "var(--viz-axis)", strokeDasharray: "3 3" }}
            content={<TrendTooltip series={series} format={format} />}
          />
          {series.map((entity, index) => (
            <Line
              key={entity.key}
              type="monotone"
              dataKey={entity.key}
              name={entity.label}
              stroke={SERIES[index % SERIES.length]}
              strokeWidth={2}
              dot={(
                <DrillDot
                  color={SERIES[index % SERIES.length]}
                  onDrill={drillPoint ? (period) => drillPoint(entity, period) : undefined}
                />
              )}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <Legend items={series.map((entity, index) => ({ key: entity.key, label: entity.label, color: SERIES[index % SERIES.length] }))} />
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        {metricLabel} per {isTimeAxis && dimension === "day" ? "day" : "month"}. A period with no purchase reads as zero,
        not as a gap.
      </p>
      <DrillHint enabled={Boolean(drillPoint)} noun={isTimeAxis ? "point" : `point — one ${dimensionLabel.toLowerCase()} in one month`} />
    </>
  )
}

// ── Value against quantity ─────────────────────────────────────────────────

function ScatterTooltip({ format, metricLabel, unit, ...injected }: InjectedTooltipProps<ComparisonRow> & Readonly<{
  format: string
  metricLabel: string
  unit: string | null
}>) {
  const row = hoveredDatum(injected)
  if (!row) return null
  return (
    <VizTooltip
      title={row.label}
      rows={[
        { label: "Value", value: money(row.spendCents), color: SERIES[0] },
        { label: `Quantity${unit ? ` (${unit})` : ""}`, value: countShort(row.quantity) },
        { label: "Avg unit price", value: money(row.avgUnitPriceCents) },
        { label: "Orders", value: countShort(row.orderCount), muted: true },
        { label: metricLabel, value: formatByKind(row.value, format), muted: true },
      ]}
    />
  )
}

function ScatterCompare({ rows, format, metricLabel, unit, dimension, onDrillDown }: Readonly<ChartProps>) {
  const usable = rows.filter((row) => row.quantity > 0)
  const drill = drillHandler(dimension, onDrillDown)

  if (usable.length === 0) {
    return (
      <p className="py-12 text-center text-xs text-slate-500 dark:text-slate-400">
        Value against quantity needs order lines with a quantity. Choose a single unit of measure to plot this.
      </p>
    )
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={320}>
        <ScatterChart margin={{ top: 16, right: 24, bottom: 32, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis
            type="number"
            dataKey="quantity"
            name="Quantity"
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            tickFormatter={countShort}
            label={{ value: unit ? `Quantity (${unit})` : "Quantity", position: "insideBottom", offset: -16, style: AXIS_STYLE }}
          />
          <YAxis
            type="number"
            dataKey="spendCents"
            name="Value"
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            width={72}
            tickFormatter={(value) => formatShortByKind(value, "currency")}
          />
          <ZAxis type="number" dataKey="orderCount" range={[60, 320]} name="Orders" />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={<ScatterTooltip format={format} metricLabel={metricLabel} unit={unit} />}
          />
          <Scatter
            data={usable}
            fill={SERIES[0]}
            fillOpacity={0.75}
            stroke="var(--viz-surface)"
            strokeWidth={2}
            isAnimationActive={false}
            onClick={drill}
            className={drill ? "cursor-pointer" : undefined}
          >
            {usable.map((row, index) => (
              <Cell key={row.key} fill={entityColor(index, true)} />
            ))}
            <LabelList
              dataKey="label"
              position="top"
              style={{ fontSize: 10, fill: "var(--viz-ink)" }}
            />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Each point is one entity: quantity across, value up, bubble size is order count. High and left means paying a lot
        for little; low and right means buying volume cheaply.
      </p>
      <DrillHint enabled={Boolean(drill)} noun="point" />
    </>
  )
}

// ── Table ──────────────────────────────────────────────────────────────────

/** What the ranked table reads; `ComparisonChart` hands it the full chart props. */
export type ComparisonTableProps = Pick<
  ChartProps,
  "rows" | "format" | "metricLabel" | "dimensionLabel" | "concentrationEligible" | "dimension" | "onDrillDown" | "budgetBeside"
>

/**
 * The table form of a ranking: the same rows, readable without colour.
 *
 * Reached two ways — as the `table` chart type in the Explore workbench, and
 * as the table view of every ranked panel on the Product Performance screen,
 * where it is what makes "graph + table" true for the bar panels and not only
 * the trends.
 */
export function ComparisonTable({
  rows, format, metricLabel, dimensionLabel, concentrationEligible, dimension, onDrillDown, budgetBeside,
}: Readonly<ComparisonTableProps>) {
  return (
    <DataTable
      columns={[
        dimensionLabel,
        metricLabel,
        ...(budgetBeside ? ["Total Budget", "% of budget"] : []),
        ...(concentrationEligible ? ["Share"] : []),
        "vs prior",
        "Orders",
      ]}
      rows={rows.map((row) => [
        row.label,
        formatByKind(row.value, format),
        ...(budgetBeside ? [money(row.totalBudgetCents ?? 0), budgetShareLabel(row.value, row.totalBudgetCents)] : []),
        ...(concentrationEligible ? [percent(row.share)] : []),
        changeLabel(row.changePct).text,
        countShort(row.orderCount),
      ])}
      // The table is the keyboard path to the same drill-down the bars give a
      // mouse, so neither reader is offered a comparison they cannot open.
      rowKeys={rows.map((row) => row.key)}
      onSelectRow={dimension && onDrillDown
        ? (key, index) => onDrillDown({ dimension, key, label: rows[index]?.label ?? key })
        : undefined}
    />
  )
}

/** The table shown for a trend, since a line chart has no single value per row. */
export function SeriesTable({ series, periods, format, onSelectEntity }: Readonly<{
  series: EntitySeries[]
  periods: string[]
  format: string
  onSelectEntity?: (key: string, index: number) => void
}>) {
  return (
    <DataTable
      columns={["Entity", ...periods]}
      rows={series.map((entity) => [
        entity.label,
        ...entity.points.map((point) => formatByKind(point.value, format)),
      ])}
      rowKeys={series.map((entity) => entity.key)}
      onSelectRow={onSelectEntity}
    />
  )
}
