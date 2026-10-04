/**
 * Executive Procurement Analytics — the curated contract.
 *
 * This module is deliberately free of the database, of React and of the
 * session, so the whitelist that decides what an analytics request may ask for
 * can be unit-tested on its own, and so the formula behind every figure has one
 * written definition instead of one per chart.
 *
 * Nothing here widens access. The registry below decides which *shapes* of
 * question are askable; `lib/server/executive-analytics-scope.ts` decides which
 * rows the answer may be drawn from, and the two are independent.
 *
 * ── Business definitions this module encodes ───────────────────────────────
 *
 * The application already owns these meanings; they are restated here, not
 * redefined. See `lib/metric-utils.ts` (order money) and
 * `lib/branch-budget-summary.ts` (budget money).
 *
 *   Revenue-eligible order   status IN (FULFILLED, APPROVED, PARTIAL,
 *                            PARTIALLY_FULFILLED)          — metric-utils
 *   Procurement Value        SUM(total_cents - refund_amount_cents) over
 *                            revenue-eligible orders       — metricExpressions.revenue
 *   Committed (Held)         SUM(total_cents - refund_amount_cents) over
 *                            PENDING + APPROVED orders     — budgets/summary route
 *   Total Budget             allocated + credited          — summarizeBranchBudget
 *   Remaining                total - spent - held          — summarizeBranchBudget
 *   Consumed                 spent + held (the "Purchases" figure the existing
 *                            Budget Report shows)          — budgets/summary route
 *   Utilization %            consumed / total * 100
 *   Variance                 total - consumed
 *   Growth %                 (current - previous) / previous * 100
 *
 * A cancelled, rejected, or fully refunded order is worth nothing in either
 * money metric. A pending order is excluded from Procurement Value but is a
 * commitment in Consumed, where Consumed is spent + held.
 */

/**
 * Roles allowed to open the Executive Analytics Center at all.
 *
 * Each one reaches more than a single branch, which is what makes a
 * side-by-side comparison worth drawing: the platform role reaches every
 * tenant, Head Office its own tenant, and the multi-branch approver the set of
 * branches its group and branch assignments resolve to. The ordering group
 * role is deliberately absent — it raises orders and has no reporting surface.
 * Which *rows* each role may draw from is decided in
 * `lib/server/executive-analytics-scope.ts`, never here.
 */
export const EXECUTIVE_ANALYTICS_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER"] as const
export type ExecutiveAnalyticsRole = (typeof EXECUTIVE_ANALYTICS_ROLES)[number]

export function isExecutiveAnalyticsRole(role: unknown): role is ExecutiveAnalyticsRole {
  return typeof role === "string"
    && (EXECUTIVE_ANALYTICS_ROLES as readonly string[]).includes(role)
}

/**
 * The aggregation grain a query must run at.
 *
 * This is the guard against join fan-out. An `order`-grain metric may never be
 * summed across a join to `order_items` (one order with three lines would count
 * three times); a `line`-grain metric may never sum `orders.total_cents`. Every
 * request resolves to exactly one grain before any SQL is built.
 */
export type AnalyticsGrain = "order" | "line" | "budget"

export type ExecutiveMetricId =
  | "spend"
  | "orders"
  | "avgOrderValue"
  | "quantity"
  | "avgUnitPrice"
  | "utilization"
  | "budgetRemaining"

export type ExecutiveDimensionId =
  | "branch"
  | "group"
  | "organization"
  | "user"
  | "category"
  | "product"
  | "month"
  | "day"

export type MetricDefinition = {
  id: ExecutiveMetricId
  label: string
  /** How the value is expressed to the reader. */
  format: "currency" | "count" | "percent" | "quantity"
  /** The grain this metric forces, regardless of dimension. */
  grain: AnalyticsGrain
  /**
   * True when the figure is only meaningful inside one unit of measure.
   * Litres and packs are not addable; the API refuses to total them.
   */
  unitSensitive: boolean
  /** The arithmetic, in the same words used in code review. */
  formula: string
  /** What a decision-maker uses it for. */
  decision: string
}

export const EXECUTIVE_METRICS: Record<ExecutiveMetricId, MetricDefinition> = {
  spend: {
    id: "spend",
    label: "Procurement Value",
    format: "currency",
    grain: "order",
    unitSensitive: false,
    formula: "SUM(order.totalCents - order.refundAmountCents) over approved and fulfilled orders",
    decision: "Where the money actually went in the selected period.",
  },
  orders: {
    id: "orders",
    label: "Orders",
    format: "count",
    grain: "order",
    unitSensitive: false,
    formula: "COUNT(order) over approved and fulfilled orders",
    decision: "Purchasing activity independent of order size.",
  },
  avgOrderValue: {
    id: "avgOrderValue",
    label: "Average Order Value",
    format: "currency",
    grain: "order",
    unitSensitive: false,
    formula: "Procurement Value / Orders (0 when there are no orders)",
    decision: "Whether a branch buys often and small, or rarely and large.",
  },
  quantity: {
    id: "quantity",
    label: "Quantity",
    format: "quantity",
    grain: "line",
    unitSensitive: false,
    formula: "SUM(orderItem.quantity) over lines of approved and fulfilled orders; each ordered item counts as one quantity regardless of its unit label",
    decision: "Ordered item counts, when money hides a price change.",
  },
  avgUnitPrice: {
    id: "avgUnitPrice",
    label: "Average Unit Price",
    format: "currency",
    grain: "line",
    unitSensitive: true,
    formula: "SUM(line value) / SUM(quantity) — a weighted average, never an average of averages",
    decision: "Whether the same goods are being bought at different prices.",
  },
  utilization: {
    id: "utilization",
    label: "Budget Utilization %",
    format: "percent",
    grain: "budget",
    unitSensitive: false,
    formula: "(spent + held) / (allocated + credited) * 100; 0 when there is no budget",
    decision: "Which branches are close to exhausting what they were given.",
  },
  budgetRemaining: {
    id: "budgetRemaining",
    label: "Remaining Budget",
    format: "currency",
    grain: "budget",
    unitSensitive: false,
    formula: "(allocated + credited) - (spent + held)",
    decision: "How much room is left before a branch stops being able to order.",
  },
}

export type DimensionDefinition = {
  id: ExecutiveDimensionId
  label: string
  /** Plural noun for the entity picker, e.g. "products". */
  entityNoun: string
  /**
   * The grain this dimension forces. Category and product only exist on order
   * lines, so asking for them moves the whole query to line grain.
   */
  forcedGrain: AnalyticsGrain | null
  metrics: readonly ExecutiveMetricId[]
  /**
   * When set, only this role may compare by this dimension. Comparing tenants
   * against each other is a platform-level question, so it belongs to the
   * platform-level role and to nobody else.
   */
  requiredRole?: ExecutiveAnalyticsRole
  /**
   * Whether the reader may pick specific members to compare. Months are a
   * continuous axis rather than a set of things, so they are not pickable.
   */
  selectable: boolean
}

/** Metrics that come from the budget ledger, so only budget-bearing entities get them. */
const BUDGET_BEARING_METRICS = [
  "spend", "orders", "avgOrderValue", "quantity", "avgUnitPrice", "utilization", "budgetRemaining",
] as const

/** Metrics available where there is procurement activity but no budget of its own. */
const ACTIVITY_METRICS = ["spend", "orders", "avgOrderValue", "quantity", "avgUnitPrice"] as const

/** Line-grain entities: an order line knows its product, not its order's average value. */
const LINE_ENTITY_METRICS = ["spend", "orders", "quantity", "avgUnitPrice"] as const

export const EXECUTIVE_DIMENSIONS: Record<ExecutiveDimensionId, DimensionDefinition> = {
  branch: {
    id: "branch",
    label: "Branch",
    entityNoun: "branches",
    forcedGrain: null,
    metrics: BUDGET_BEARING_METRICS,
    selectable: true,
  },
  // A group is a set of branches, so its budget is the sum of theirs.
  group: {
    id: "group",
    label: "Group",
    entityNoun: "groups",
    forcedGrain: null,
    metrics: BUDGET_BEARING_METRICS,
    selectable: true,
  },
  // Comparing tenants is a platform question and stays with the platform role.
  organization: {
    id: "organization",
    label: "Organization",
    entityNoun: "organizations",
    forcedGrain: null,
    metrics: BUDGET_BEARING_METRICS,
    requiredRole: "SUPER_ADMIN",
    selectable: true,
  },
  // The person who raised the order. No budget is held against a requester, so
  // the budget metrics are absent rather than reported as zero.
  user: {
    id: "user",
    label: "Requester",
    entityNoun: "people",
    forcedGrain: null,
    metrics: ACTIVITY_METRICS,
    selectable: true,
  },
  category: {
    id: "category",
    label: "Category",
    entityNoun: "categories",
    forcedGrain: "line",
    metrics: LINE_ENTITY_METRICS,
    selectable: true,
  },
  product: {
    id: "product",
    label: "Product",
    entityNoun: "products",
    forcedGrain: "line",
    metrics: LINE_ENTITY_METRICS,
    selectable: true,
  },
  // A continuous axis, not a set of things to tick.
  month: {
    id: "month",
    label: "Month",
    entityNoun: "months",
    forcedGrain: null,
    metrics: ACTIVITY_METRICS,
    selectable: false,
  },
  /**
   * The same axis one grain finer, for "pick a month and a product, show me the
   * daily consumption". Not selectable for the same reason months are not, and
   * capped at `MAX_TIME_AXIS_POINTS` buckets so a two-year window cannot ask
   * for seven hundred of them.
   */
  day: {
    id: "day",
    label: "Day",
    entityNoun: "days",
    forcedGrain: null,
    metrics: ACTIVITY_METRICS,
    selectable: false,
  },
}

/**
 * Dimensions that *are* the time axis rather than a set of things ranked along
 * one.
 *
 * This distinction decides two separate things and both were wrong for `month`
 * before `day` existed: which chart forms are offered (ranking months by size
 * destroys the only thing that makes them meaningful), and what a "series"
 * response means — one line over the periods, not one line *per* period.
 */
export const TIME_AXIS_DIMENSIONS = ["month", "day"] as const

export function isTimeAxisDimension(dimension: unknown): dimension is "month" | "day" {
  return typeof dimension === "string"
    && (TIME_AXIS_DIMENSIONS as readonly string[]).includes(dimension)
}

/** How many time buckets one comparison may return, so a wide range stays bounded. */
export const MAX_TIME_AXIS_POINTS: Record<"month" | "day", number> = {
  month: 120,
  day: 400,
}

/** Dimensions the caller's role may compare by. */
export function dimensionsForRole(role: unknown): DimensionDefinition[] {
  return Object.values(EXECUTIVE_DIMENSIONS)
    .filter((dimension) => !dimension.requiredRole || dimension.requiredRole === role)
}

export function isDimensionAllowedForRole(dimension: unknown, role: unknown): boolean {
  if (!isExecutiveDimension(dimension)) return false
  const required = EXECUTIVE_DIMENSIONS[dimension].requiredRole
  return !required || required === role
}

export function isExecutiveDimension(value: unknown): value is ExecutiveDimensionId {
  return typeof value === "string" && value in EXECUTIVE_DIMENSIONS
}

export function isExecutiveMetric(value: unknown): value is ExecutiveMetricId {
  return typeof value === "string" && value in EXECUTIVE_METRICS
}

/** Whether this pairing is one the server will answer at all. */
export function isSupportedCombination(dimension: unknown, metric: unknown): boolean {
  if (!isExecutiveDimension(dimension) || !isExecutiveMetric(metric)) return false
  return EXECUTIVE_DIMENSIONS[dimension].metrics.includes(metric)
}

export function metricsForDimension(dimension: ExecutiveDimensionId): MetricDefinition[] {
  return EXECUTIVE_DIMENSIONS[dimension].metrics.map((id) => EXECUTIVE_METRICS[id])
}

/**
 * The one grain the query runs at. A budget metric wins outright — it does not
 * read orders at all — then a line-grain metric or a line-only dimension.
 */
/** The entities a budget is actually held against, directly or by rollup. */
export const BUDGET_ROLLUP_DIMENSIONS = ["branch", "group", "organization"] as const

export function isBudgetRollupDimension(dimension: unknown): dimension is "branch" | "group" | "organization" {
  return typeof dimension === "string"
    && (BUDGET_ROLLUP_DIMENSIONS as readonly string[]).includes(dimension)
}

export function resolveGrain(
  dimension: ExecutiveDimensionId,
  metric: ExecutiveMetricId,
  options?: {
    /**
     * True when the request is narrowed to particular products or categories.
     *
     * This changes the right answer for money. At order grain, "spend by branch
     * for product X" sums the *whole* value of every order that happened to
     * contain X — on real data that came out 5.7x too high. Narrowing to lines
     * means only X's own lines may count, so the query has to move to line
     * grain. Quantity and unit price are already line-grain and unaffected.
     */
    lineScoped?: boolean
  },
): AnalyticsGrain {
  const metricGrain = EXECUTIVE_METRICS[metric].grain
  if (metricGrain === "budget") return "budget"
  if (metricGrain === "line") return "line"
  if (EXECUTIVE_DIMENSIONS[dimension].forcedGrain === "line") return "line"
  if (options?.lineScoped && metric === "spend") return "line"
  return EXECUTIVE_DIMENSIONS[dimension].forcedGrain ?? "order"
}

/**
 * Metrics that stop being meaningful once the request is narrowed to particular
 * products.
 *
 * "Average order value for product X" is the average of whole orders that
 * happened to contain X, which reads as though it were X's own average and is
 * not. Rather than relabel it into a sentence nobody would trust, it is
 * withdrawn while a focus is active.
 */
export function metricsUnderLineFocus(metrics: readonly ExecutiveMetricId[]): ExecutiveMetricId[] {
  return metrics.filter((metric) => metric !== "avgOrderValue")
}

/** How many rows a comparison may return, so one request cannot scan unbounded. */
export const EXECUTIVE_MAX_ROWS = 50
export const EXECUTIVE_DEFAULT_ROWS = 12

export function clampRowLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return EXECUTIVE_DEFAULT_ROWS
  return Math.min(parsed, EXECUTIVE_MAX_ROWS)
}

// ── Chart types ────────────────────────────────────────────────────────────

/**
 * The chart forms the workbench offers, and the rules deciding which are on the
 * menu for a given question.
 *
 * The rules exist because the wrong form actively misleads. A donut of twenty
 * slices cannot be read; a donut of averages is arithmetic nonsense, because
 * averages are not parts of a whole; a line chart of things that have no time
 * order invents a trend. Rather than let a reader pick those and then explain
 * the result away, the unusable forms are simply not offered, each with a
 * stated reason.
 */
export type ChartTypeId = "bar" | "column" | "grouped" | "donut" | "line" | "scatter" | "table"

export type ChartTypeDefinition = {
  id: ChartTypeId
  label: string
  /** What this form is for, shown as the option's help text. */
  purpose: string
  /** "rank" is one value per entity; "series" is one line per entity over time. */
  mode: "rank" | "series"
}

export const CHART_TYPES: Record<ChartTypeId, ChartTypeDefinition> = {
  bar: { id: "bar", label: "Ranked bars", purpose: "Rank entities against each other. The safe default.", mode: "rank" },
  column: { id: "column", label: "Columns", purpose: "Same comparison upright, for a handful of short labels.", mode: "rank" },
  grouped: { id: "grouped", label: "This vs prior period", purpose: "Each entity now against the equivalent window before it.", mode: "rank" },
  donut: { id: "donut", label: "Share of total", purpose: "Part-of-whole, when a few entities make up the total.", mode: "rank" },
  line: { id: "line", label: "Trend over time", purpose: "How each selected entity moved, month by month.", mode: "series" },
  scatter: { id: "scatter", label: "Value vs quantity", purpose: "Spot entities buying a lot cheaply, or a little dearly.", mode: "rank" },
  table: { id: "table", label: "Table", purpose: "Every figure as text, readable without colour.", mode: "rank" },
}

/**
 * Metrics that can be meaningfully added up across entities.
 *
 * Only these can form a part-of-whole, so only these may be drawn as a donut.
 * An average or a percentage cannot: three branches at 90% utilization do not
 * make 270% of anything.
 */
const ADDITIVE_METRICS: ReadonlySet<string> = new Set<ExecutiveMetricId>(["spend", "quantity", "orders", "budgetRemaining"])

export function isAdditiveMetric(metric: unknown): boolean {
  return typeof metric === "string" && ADDITIVE_METRICS.has(metric)
}

/** Past this many slices a donut is unreadable, so it stops being offered. */
export const DONUT_MAX_SLICES = 6

export type ChartTypeOption = ChartTypeDefinition & {
  /** Present when the form is offered but currently unusable, and why. */
  disabledReason?: string
}

/**
 * The chart menu for one question, with a reason attached to anything that is
 * on the menu but not currently usable — so the reader learns why rather than
 * finding an option silently missing.
 */
export function chartTypesFor({ dimension, metric, entityCount }: {
  dimension: ExecutiveDimensionId
  metric: ExecutiveMetricId
  /** How many entities the comparison currently resolves to. */
  entityCount: number
}): ChartTypeOption[] {
  const isBudgetMetric = EXECUTIVE_METRICS[metric].grain === "budget"
  const option = (id: ChartTypeId, disabledReason?: string): ChartTypeOption =>
    ({ ...CHART_TYPES[id], disabledReason })

  if (isTimeAxisDimension(dimension)) {
    // Months already run along an axis; ranking them by size would destroy the
    // one thing that makes them meaningful.
    return [option("line"), option("column"), option("table")]
  }

  return [
    option("bar"),
    option("column"),
    option("grouped", isBudgetMetric
      ? "A budget position is a snapshot of the selected period, so there is no prior-period figure to set beside it."
      : undefined),
    option("donut", donutWithheldReason(dimension, metric, entityCount)),
    option("line", isBudgetMetric
      ? "The budget ledger is monthly and per branch, so a budget position has no trend line of its own here."
      : undefined),
    option("scatter", isBudgetMetric
      ? "Value against quantity needs order lines; a budget position has none."
      : undefined),
    option("table"),
  ]
}

function donutWithheldReason(
  dimension: ExecutiveDimensionId,
  metric: ExecutiveMetricId,
  entityCount: number,
): string | undefined {
  if (!isAdditiveMetric(metric)) {
    return `${EXECUTIVE_METRICS[metric].label} is an average, not a part of a whole, so a share chart would be meaningless.`
  }
  if (entityCount > DONUT_MAX_SLICES) {
    return `Too many ${EXECUTIVE_DIMENSIONS[dimension].entityNoun} to read as slices. Pick ${DONUT_MAX_SLICES} or fewer.`
  }
  if (entityCount === 0) return "Nothing to divide up yet."
  return undefined
}

export function isChartType(value: unknown): value is ChartTypeId {
  return typeof value === "string" && value in CHART_TYPES
}

/** The response shape a chart needs: one value per entity, or a time series. */
export function chartMode(chart: ChartTypeId): "rank" | "series" {
  return CHART_TYPES[chart].mode
}

/** How many entities may be compared at once, so one request stays bounded. */
export const MAX_COMPARE_ENTITIES = 25

// ── The grid: one figure per pair ──────────────────────────────────────────

/**
 * The dimensions a two-way grid may be laid out on.
 *
 * Only entities whose ranked keys are plain ids that fold straight back into a
 * filter: a person, a product, a category, a branch. The time axes are absent
 * because a period is not a thing to cross with another; groups and
 * organizations because their keys are resolved into the branch fence
 * upstream rather than filtered downstream, and a budget-bearing rollup has
 * nothing to say per product anyway.
 */
export const MATRIX_DIMENSIONS = ["user", "product", "category", "branch"] as const satisfies readonly ExecutiveDimensionId[]
export type MatrixDimensionId = (typeof MATRIX_DIMENSIONS)[number]

/**
 * The measures a cell may hold.
 *
 * Never a budget figure — a budget is held per branch, and there is no such
 * thing as "Ahmed's budget for toner". Never the average order value either,
 * for the reason `metricsUnderLineFocus` gives: a product on one axis makes
 * every cell line-scoped, and the average of whole orders that happened to
 * contain the product is not the product's own average.
 */
export const MATRIX_METRICS = ["spend", "orders", "quantity", "avgUnitPrice"] as const satisfies readonly ExecutiveMetricId[]

/** How many entities each axis may carry, so a grid stays readable and bounded. */
export const MATRIX_MAX_ENTITIES = 12
export const MATRIX_DEFAULT_ENTITIES = 8

export function isMatrixDimension(value: unknown): value is MatrixDimensionId {
  return typeof value === "string" && (MATRIX_DIMENSIONS as readonly string[]).includes(value)
}

export function isMatrixMetric(value: unknown): value is ExecutiveMetricId {
  return typeof value === "string" && (MATRIX_METRICS as readonly string[]).includes(value)
}

/**
 * Whether the server will lay out this grid at all. Both axes must be grid
 * dimensions and different from each other, and the metric must be one both
 * of them already answer on their own — a cell is a narrowing of two bars.
 */
export function isSupportedMatrix(rows: unknown, columns: unknown, metric: unknown): boolean {
  if (!isMatrixDimension(rows) || !isMatrixDimension(columns) || rows === columns) return false
  if (!isMatrixMetric(metric)) return false
  return EXECUTIVE_DIMENSIONS[rows].metrics.includes(metric)
    && EXECUTIVE_DIMENSIONS[columns].metrics.includes(metric)
}

export function clampMatrixLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return MATRIX_DEFAULT_ENTITIES
  return Math.min(parsed, MATRIX_MAX_ENTITIES)
}

/**
 * The grain a pair of axes forces: line grain the moment either axis, the
 * metric or a focus needs order lines, order grain only when every part of the
 * question can be answered from whole orders (a person against a branch, in
 * money). Never budget grain — `isSupportedMatrix` has already refused those.
 */
export function resolveMatrixGrain(
  rows: MatrixDimensionId,
  columns: MatrixDimensionId,
  metric: ExecutiveMetricId,
  options?: { lineScoped?: boolean },
): "order" | "line" {
  const forced = [rows, columns].some((axis) => resolveGrain(axis, metric, options) === "line")
  return forced ? "line" : "order"
}

// ── Budget beside the bars ─────────────────────────────────────────────────

/**
 * The dimensions a Total Budget column can stand beside a Procurement Value
 * column: the entities a budget is held against, directly or by rollup, and
 * the month — the grain the ledger itself is kept at, so a month's budget is
 * the sum of the fenced branches' allocations for that period.
 */
export const BUDGET_BESIDE_DIMENSIONS = ["branch", "group", "organization", "month"] as const satisfies readonly ExecutiveDimensionId[]
export type BudgetBesideDimension = (typeof BUDGET_BESIDE_DIMENSIONS)[number]

export function isBudgetBesideDimension(value: unknown): value is BudgetBesideDimension {
  return typeof value === "string" && (BUDGET_BESIDE_DIMENSIONS as readonly string[]).includes(value)
}

/** The narrowings a request may carry that a budget cannot follow. */
export type BudgetBesideNarrowing = {
  /** Narrowed to particular products or categories. */
  lineScoped: boolean
  /** Narrowed to particular requesters. */
  userScoped: boolean
}

/**
 * Why a budget cannot be set beside this comparison, in the reader's words —
 * or null when it can.
 *
 * A budget is money held per branch per month, and nothing else: it has no
 * quantity, no share for one product and no share for one person. So it is
 * withheld — never approximated — the moment the comparison measures anything
 * but money, or is narrowed to products, categories or requesters. One rule
 * decides both what a panel asks for and what the server will attach, so
 * neither side can show a budget the other would not.
 */
export function budgetBesideWithheldReason(
  dimension: ExecutiveDimensionId,
  metric: ExecutiveMetricId,
  narrowing: BudgetBesideNarrowing,
): string | null {
  if (!isBudgetBesideDimension(dimension)) {
    return `Budget is held per branch and per month, so there is no budget to set beside each ${EXECUTIVE_DIMENSIONS[dimension].label.toLowerCase()}.`
  }
  if (metric !== "spend") return "Budget is money, so it is shown beside the bars only when measuring by amount."
  if (narrowing.lineScoped) return "Budget is held per branch, not per product, so it is shown only against all products. Clear the product focus to see it."
  if (narrowing.userScoped) return "Budget is held per branch, not per requester, so it is shown only against all requesters. Clear the requesters to see it."
  return null
}

export function canShowBudgetBeside(
  dimension: ExecutiveDimensionId,
  metric: ExecutiveMetricId,
  narrowing: BudgetBesideNarrowing,
): boolean {
  return budgetBesideWithheldReason(dimension, metric, narrowing) === null
}

// ── Arithmetic ─────────────────────────────────────────────────────────────
// Every one of these is written to survive a zero denominator, because a branch
// with no budget and a period with no history are both ordinary states here.

export function utilizationPct(consumedCents: number, totalBudgetCents: number): number {
  if (!Number.isFinite(totalBudgetCents) || totalBudgetCents <= 0) return 0
  return (consumedCents / totalBudgetCents) * 100
}

export function varianceCents(totalBudgetCents: number, consumedCents: number): number {
  return totalBudgetCents - consumedCents
}

/**
 * Period-over-period change. `null` — not zero — when the previous period had
 * nothing to grow from: "no baseline" and "no change" are different answers and
 * the chart must not draw them the same way.
 */
export function growthPct(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null
  return ((current - previous) / previous) * 100
}

export function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator === 0) return 0
  return numerator / denominator
}

/**
 * Weighted average unit price. Never an average of per-order averages, which
 * would let a single one-unit order outweigh a thousand-unit one.
 */
export function weightedAverageUnitPrice(totalValueCents: number, totalQuantity: number): number {
  return safeDivide(totalValueCents, totalQuantity)
}

// ── Exception thresholds ───────────────────────────────────────────────────
/**
 * These are analytics presentation thresholds, not business rules the
 * application enforces anywhere. Nothing is approved, blocked or charged
 * differently because of them — they only decide what the "Needs attention"
 * panel puts at the top. They are named and exported so a reader can see the
 * exact number behind every flag rather than inferring it from a colour.
 */
export const EXECUTIVE_THRESHOLDS = {
  /** Utilization at or above this is flagged as approaching the limit. */
  budgetWarningPct: 90,
  /** Above this the branch has consumed more than it was given. */
  budgetOverPct: 100,
  /** Utilization below this, with budget allocated, is flagged as under-used. */
  budgetUnderusedPct: 40,
  /** Period-over-period spend change beyond this is flagged as a swing. */
  spendSwingPct: 25,
  /**
   * Spread between the cheapest and dearest branch unit price for the same
   * product and unit, above which the buying inconsistency is worth a look.
   */
  priceSpreadPct: 15,
  /** A pending order older than this many days is flagged as stuck. */
  pendingOrderAgingDays: 7,
} as const

export type BudgetHealth = "over" | "warning" | "healthy" | "underused" | "unbudgeted"

export function classifyBudgetHealth(totalBudgetCents: number, consumedCents: number): BudgetHealth {
  if (!Number.isFinite(totalBudgetCents) || totalBudgetCents <= 0) return "unbudgeted"
  const pct = utilizationPct(consumedCents, totalBudgetCents)
  if (pct > EXECUTIVE_THRESHOLDS.budgetOverPct) return "over"
  if (pct >= EXECUTIVE_THRESHOLDS.budgetWarningPct) return "warning"
  if (pct < EXECUTIVE_THRESHOLDS.budgetUnderusedPct) return "underused"
  return "healthy"
}

// ── Row order ──────────────────────────────────────────────────────────────

/**
 * The order comparison rows reach the reader in: a time axis in its own
 * order, every other dimension largest first.
 *
 * Each grouped read is already ordered in SQL, but by its own value column —
 * the line read by net value, whatever the metric — so a metric that is not
 * that column (quantity, unit price, an order count) is re-ranked here by the
 * value the reader asked for. A time axis is never re-ranked, under any
 * metric: months in size order stop being months, and the one thing the
 * panel can show — how consumption moved — is gone. That rule used to be
 * gated on the metric's own grain, which put "By month" in size order the
 * moment a product came into focus and the read moved to line grain.
 */
export function orderComparisonRows<T extends { key: string; value: number }>(
  rows: readonly T[],
  dimension: ExecutiveDimensionId,
): T[] {
  return [...rows].sort((left, right) => (
    isTimeAxisDimension(dimension) ? left.key.localeCompare(right.key) : right.value - left.value
  ))
}

// ── Concentration (Pareto) ─────────────────────────────────────────────────

export type ParetoPoint<T> = T & { share: number; cumulativeShare: number }

/**
 * Running share of the total, largest first. Used for the 80/20 question
 * ("which few categories carry most of the spend?"). Values must already be
 * sorted descending by the caller's SQL; this only accumulates.
 */
export function withCumulativeShare<T>(rows: T[], valueOf: (row: T) => number): ParetoPoint<T>[] {
  const total = rows.reduce((sum, row) => sum + Math.max(0, valueOf(row)), 0)
  let running = 0
  return rows.map((row) => {
    const value = Math.max(0, valueOf(row))
    running += value
    return {
      ...row,
      share: total > 0 ? (value / total) * 100 : 0,
      cumulativeShare: total > 0 ? (running / total) * 100 : 0,
    }
  })
}

/** How many leading rows it takes to reach `targetShare` of the total. */
export function countToReachShare<T>(
  rows: ParetoPoint<T>[],
  targetShare = 80,
): number {
  const index = rows.findIndex((row) => row.cumulativeShare >= targetShare)
  return index === -1 ? rows.length : index + 1
}

// ── Unit-of-measure safety ─────────────────────────────────────────────────

/**
 * Resolves a single unit for a unit-sensitive figure such as average unit price.
 *
 * Quantity itself is intentionally a raw ordered-item count and does not call
 * this resolver. When a genuinely unit-sensitive metric spans more than one
 * unit, the API returns the unit list and refuses the mixed denominator.
 */
export function resolveQuantityUnit(
  unitsInScope: string[],
  requestedUnit: string | null | undefined,
): { unit: string | null; conflict: boolean; units: string[] } {
  const units = Array.from(new Set(unitsInScope.filter((unit) => typeof unit === "string" && unit.length > 0))).sort((a, b) => a.localeCompare(b))
  const requested = requestedUnit?.trim() || ""

  if (requested && units.includes(requested)) return { unit: requested, conflict: false, units }
  if (units.length === 1) return { unit: units[0], conflict: false, units }
  if (units.length === 0) return { unit: null, conflict: false, units }
  return { unit: null, conflict: true, units }
}

// ── Chart registry ─────────────────────────────────────────────────────────
/**
 * Every visual on the Executive Overview, with the management question it
 * exists to answer. A chart that cannot state its question does not belong on
 * the page, so the page renders from this list rather than from hardcoded JSX
 * headings.
 */
export type ExecutiveChartDefinition = {
  id: string
  title: string
  businessQuestion: string
  decision: string
  metric: string
  chart: "grouped-bar" | "ranked-bar" | "line" | "pareto" | "heatmap" | "stacked-bar" | "list"
  priority: "P0" | "P1" | "P2"
}

export const EXECUTIVE_CHARTS: ExecutiveChartDefinition[] = [
  {
    id: "budget-vs-actual",
    title: "Budget vs Consumed by Branch",
    businessQuestion: "Is each branch living within the budget it was given?",
    decision: "Move budget toward branches that need it, away from branches that cannot use it.",
    metric: "Total Budget, Consumed, Remaining",
    chart: "grouped-bar",
    priority: "P0",
  },
  {
    id: "utilization-ranking",
    title: "Budget Utilization Ranking",
    businessQuestion: "Which branch is closest to exhausting its budget?",
    decision: "Intervene before a branch is blocked from ordering.",
    metric: "Utilization %",
    chart: "ranked-bar",
    priority: "P0",
  },
  {
    id: "procurement-trend",
    title: "Procurement Trend",
    businessQuestion: "Are we spending faster than we were?",
    decision: "Adjust the run rate while the period is still open.",
    metric: "Procurement Value by month, current vs previous period",
    chart: "line",
    priority: "P0",
  },
  {
    id: "category-pareto",
    title: "Spend Concentration by Category",
    businessQuestion: "Which few categories carry most of our procurement cost?",
    decision: "Concentrate negotiation effort where the money actually is.",
    metric: "Procurement Value by category, with cumulative share",
    chart: "pareto",
    priority: "P0",
  },
  {
    id: "branch-category-heatmap",
    title: "Branch × Category Mix",
    businessQuestion: "Is any branch's category mix unlike its peers?",
    decision: "Ask why one branch buys a category the others do not.",
    metric: "Procurement Value, share of branch total",
    chart: "heatmap",
    priority: "P1",
  },
  {
    id: "price-variance",
    title: "Same Product, Different Price",
    businessQuestion: "Are branches paying different prices for the same item?",
    decision: "Consolidate buying, or explain the gap.",
    metric: "Weighted average unit price by branch, same product and unit",
    chart: "ranked-bar",
    priority: "P1",
  },
  {
    id: "process-funnel",
    title: "Order Status Composition by Branch",
    businessQuestion: "Where is the procurement process getting stuck?",
    decision: "Chase the approver whose queue is not moving.",
    metric: "Order count by status, as a share of each branch's orders",
    chart: "stacked-bar",
    priority: "P1",
  },
  {
    id: "attention",
    title: "Needs Attention",
    businessQuestion: "Where should I look first?",
    decision: "Work the shortlist instead of reading every chart.",
    metric: "Rule-based exceptions against documented thresholds",
    chart: "list",
    priority: "P0",
  },
]

// ── Amount ⇄ Quantity ──────────────────────────────────────────────────────

/**
 * The two ways the same purchase is measured, as a first-class pair.
 *
 * "Money" and "how much stuff" answer different questions and a reader flips
 * between them constantly — a branch whose spend rose 20% while its quantity
 * fell 5% is paying more for less, and neither number says that alone. The pair
 * is named here rather than left implicit in a seven-option metric row so the
 * toggle, the drill-down and the panel registry all agree on what "the other
 * measure" is.
 *
 * Switching measure changes *only* the metric. Filters, the focused products,
 * the compared entities and any open drill-down are deliberately untouched.
 */
export type MeasureId = "amount" | "quantity"

export const MEASURE_METRIC: Record<MeasureId, ExecutiveMetricId> = {
  amount: "spend",
  quantity: "quantity",
}

export const MEASURE_LABEL: Record<MeasureId, string> = {
  amount: "Amount",
  quantity: "Quantity",
}

export function isMeasureId(value: unknown): value is MeasureId {
  return value === "amount" || value === "quantity"
}

/** The measure a metric belongs to, so a toggle can show the right side as pressed. */
export function measureOfMetric(metric: ExecutiveMetricId): MeasureId {
  return metric === "quantity" || metric === "avgUnitPrice" ? "quantity" : "amount"
}

// ── Drill-down ─────────────────────────────────────────────────────────────

/**
 * The detail behind a clicked bar: the order lines that add up to it.
 *
 * A chart answers "how much"; the only honest answer to "why" is the rows
 * themselves. The listing is bounded because it is the one place in the Center
 * that returns individual records rather than an aggregate — an unbounded
 * `limit` here would be a data-exfiltration path, not a convenience.
 */
export const DRILLDOWN_DEFAULT_ROWS = 50
export const DRILLDOWN_MAX_ROWS = 200
export const DRILLDOWN_MAX_OFFSET = 5000

export function clampDrillDownLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return DRILLDOWN_DEFAULT_ROWS
  return Math.min(parsed, DRILLDOWN_MAX_ROWS)
}

export function clampDrillDownOffset(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(parsed, DRILLDOWN_MAX_OFFSET)
}

/**
 * Sortable columns, as an allowlist.
 *
 * A sort key is the classic way user input reaches an ORDER BY. Nothing outside
 * this list is accepted, and the value is used to *select* a pre-written
 * expression rather than to build one.
 */
export const DRILLDOWN_SORT_KEYS = [
  "date", "value", "quantity", "unitPrice", "branch", "requester", "product",
] as const
export type DrillDownSortKey = (typeof DRILLDOWN_SORT_KEYS)[number]

export function isDrillDownSortKey(value: unknown): value is DrillDownSortKey {
  return typeof value === "string" && (DRILLDOWN_SORT_KEYS as readonly string[]).includes(value)
}

export function resolveDrillDownSort(value: unknown): DrillDownSortKey {
  return isDrillDownSortKey(value) ? value : "date"
}

export function resolveSortDirection(value: unknown): "asc" | "desc" {
  return value === "asc" ? "asc" : "desc"
}

/**
 * Which orders an analytics request counts, as an allowlist.
 *
 * `revenue` is the Center's own rule and the default: the lines behind a
 * Procurement Value figure. `consumed` adds orders still awaiting approval,
 * so a figure reconciles with the budget's "spent + held". The Product
 * Performance Amount view and the budget-burn watchlist use it. The value
 * selects a pre-written status predicate and never reaches SQL as text.
 */
export const DRILLDOWN_STATUS_SETS = ["revenue", "consumed"] as const
export type DrillDownStatusSet = (typeof DRILLDOWN_STATUS_SETS)[number]

export function isDrillDownStatusSet(value: unknown): value is DrillDownStatusSet {
  return typeof value === "string" && (DRILLDOWN_STATUS_SETS as readonly string[]).includes(value)
}

/**
 * Reader-facing metric copy for the selected order population.
 *
 * The registry remains the revenue-default vocabulary used by Overview and
 * Explore. Product Performance opts into `consumed`, so every API response,
 * chart fallback, detail table, and export receives the same name and formula
 * without relabelling unrelated reports.
 */
export function metricDefinitionForStatusSet(
  metric: ExecutiveMetricId,
  statusSet: DrillDownStatusSet = "revenue",
): MetricDefinition {
  const definition = EXECUTIVE_METRICS[metric]
  if (statusSet !== "consumed") return definition

  const consumedFormula: Partial<Record<ExecutiveMetricId, string>> = {
    spend: "SUM(max(0, order total - approved/completed refunds)) over consumed orders, including pending",
    orders: "COUNT(order) over consumed orders, including pending",
    avgOrderValue: "Consumed / Orders (0 when there are no orders)",
    quantity: "SUM(max(0, ordered quantity - approved/completed refunded quantity)) over consumed order lines, including pending",
    avgUnitPrice: "Consumed line value / consumed quantity - a weighted average, never an average of averages",
  }

  return {
    ...definition,
    label: metric === "spend" ? "Consumed" : definition.label,
    formula: consumedFormula[metric] ?? definition.formula,
  }
}

// ── The side-by-side screen ────────────────────────────────────────────────

/**
 * The panels that make up "one product, every angle, on one screen".
 *
 * Held as a registry rather than as hardcoded JSX for the same reason
 * `EXECUTIVE_CHARTS` is: a panel that cannot state the question it answers does
 * not belong on the page, and the set is then testable without rendering
 * anything. Every panel is served by the *existing* comparison endpoint with a
 * different dimension — there is no new aggregation path behind this screen.
 */
export type SideBySidePanel = {
  id: string
  dimension: ExecutiveDimensionId
  chart: ChartTypeId
  title: string
  question: string
  /** Distinct hues per entity. False for a time axis, where one hue is correct. */
  colorful: boolean
  /** Rendered only when exactly one product is in focus. */
  requiresSingleProduct?: boolean
  /**
   * Withheld when exactly one product is in focus.
   *
   * Used for panels whose single-product form is replaced by the more useful
   * day-by-day view.
   */
  hiddenForSingleProduct?: boolean
  /**
   * When set, the panel asks for each entity's Total Budget beside its
   * Procurement Value, and draws the two as a pair of columns. Only while
   * `budgetBesideWithheldReason` allows it — money, and no product or
   * requester narrowing — and only for a `BUDGET_BESIDE_DIMENSIONS` dimension;
   * otherwise the panel draws its plain columns and says why.
   */
  budgetBeside?: boolean
  /**
   * When set, and at least `SEGMENT_MIN_COMPARED` entities of this dimension
   * are picked to compare, the panel becomes a two-way grid served by
   * `/matrix` — this dimension as the rows, `dimension` as the columns, one
   * figure per pair — drawn as grouped columns: one cluster per column entity,
   * one column per compared entity inside it, never combined. Below the
   * threshold the panel draws its ordinary ranking from `/compare`, since one
   * person is no comparison and nobody picked would split by the top twelve.
   */
  segmentBy?: MatrixDimensionId
  /**
   * Each column is labelled with both of its figures — quantity above value
   * — rather than with the one measure the columns are drawn from.
   *
   * "Twelve reams for 142,800" is one reading, and made of two columns' worth
   * of flipping the Amount ⇄ Quantity toggle otherwise, so every column panel
   * carries it. Only the printing changes; the height is still the selected
   * measure. Beside a budget column it labels the value column alone.
   */
  dualValueLabels?: boolean
  /**
   * What the panel's slot says while a single product is focused, for a panel
   * that is `hiddenForSingleProduct`. The slot stays on screen as a note rather
   * than collapsing, so the panels after it keep their places in the grid.
   */
  withheldNote?: string
}

/** Fewer compared entities than this and a split would show nothing to compare. */
export const SEGMENT_MIN_COMPARED = 2

/** The dimension a panel's columns are split by for this many compared entities, or null for none. */
export function panelSegmentation(panel: SideBySidePanel, comparedCount: number): MatrixDimensionId | null {
  return panel.segmentBy && comparedCount >= SEGMENT_MIN_COMPARED ? panel.segmentBy : null
}

export const SIDE_BY_SIDE_PANELS: SideBySidePanel[] = [
  /**
   * Item-wise: products against each other. With no focus this ranks the top
   * products in scope; with several ticked it compares exactly those, because
   * the focus already travels as `productIds` and the ranking is drawn from it.
   *
   * The ranked panels draw upright columns rather than bars listed downward,
   * so the comparison reads left to right like the month panel beside it.
   *
   * With several requesters picked to compare, the panel becomes requester
   * against product, uncombined: one cluster per product, one column per
   * person inside it, so "who consumed how much of this product" is read
   * across a cluster and "what did this person consume" across one colour.
   * "By requester" with three products in focus gives one bar per person
   * summed over the three; this gives the nine figures behind those bars.
   */
  {
    id: "by-product",
    dimension: "product",
    chart: "column",
    title: "By product",
    question: "Which products were ordered the most? The tallest bar is the product with the highest total.",
    colorful: true,
    segmentBy: "user",
    dualValueLabels: true,
  },
  /**
   * The category angle the requirement lists beside the product one. Withheld
   * for a single focused product because one product belongs to one category,
   * so the panel would be one bar.
   */
  {
    id: "by-category",
    dimension: "category",
    chart: "column",
    title: "By category",
    question: "Which product categories were ordered the most? Each bar adds up every product in that category.",
    colorful: true,
    hiddenForSingleProduct: true,
    withheldNote: "A single product belongs to one category, so there is nothing to compare here. Choose more products, or clear the selection, to see it.",
    dualValueLabels: true,
  },
  {
    id: "by-requester",
    dimension: "user",
    chart: "column",
    title: "By requester",
    question: "Which people ordered the most? Each bar is one person's total.",
    colorful: true,
    dualValueLabels: true,
  },
  /**
   * The two panels whose entities hold a budget — a branch directly, a month
   * as the ledger's own grain — set the Total Budget beside each column, so
   * "which consumed the most" is read against "and how much was it given".
   */
  {
    id: "by-branch",
    dimension: "branch",
    chart: "column",
    title: "By branch",
    question: "How much each branch ordered, shown next to the budget that branch was given.",
    colorful: true,
    budgetBeside: true,
    dualValueLabels: true,
  },
  {
    id: "by-month",
    dimension: "month",
    chart: "column",
    title: "By month",
    question: "How much was ordered in each month, shown next to that month's budget.",
    colorful: false,
    budgetBeside: true,
    dualValueLabels: true,
  },
  {
    id: "requesters-over-months",
    dimension: "user",
    chart: "line",
    title: "Requesters over months",
    question: "How each person's orders went up or down from month to month. Each line is one person.",
    colorful: true,
  },
  {
    id: "products-over-months",
    dimension: "product",
    chart: "line",
    title: "Products over months",
    question: "How each product's orders went up or down from month to month. Each line is one product.",
    colorful: true,
    hiddenForSingleProduct: true,
    withheldNote: "With one product chosen, its day-by-day consumption is shown below instead. Choose more products, or clear the selection, to see this.",
  },
  {
    id: "day-by-day",
    dimension: "day",
    chart: "line",
    title: "Day-by-day consumption",
    question: "How much of this product was ordered on each day of the selected period.",
    colorful: false,
    requiresSingleProduct: true,
  },
]

/** The panels to render for the current focus. */
export function panelsForFocus(focusedProductCount: number): SideBySidePanel[] {
  const single = focusedProductCount === 1
  return SIDE_BY_SIDE_PANELS.filter((panel) => {
    if (panel.requiresSingleProduct && !single) return false
    if (panel.hiddenForSingleProduct && single) return false
    return true
  })
}

/** One place in the Product Performance grid: a panel, or the note standing in for it. */
export type SideBySidePanelSlot = { panel: SideBySidePanel; withheld: boolean }

/**
 * The grid's places for the current focus, in registry order.
 *
 * Every panel `panelsForFocus` renders, plus a withheld slot where a
 * `hiddenForSingleProduct` panel would stand. Focusing one product therefore
 * never moves the panels after it into a different place — a reader who
 * changes a filter finds each chart where they left it. A withheld slot fetches
 * nothing and is not part of the download; `panelsForFocus` stays the answer to
 * "what is drawn". The single-product day panel is last in the registry, so it
 * joins and leaves at the end without displacing anything.
 */
export function panelSlotsForFocus(focusedProductCount: number): SideBySidePanelSlot[] {
  const shown = new Set(panelsForFocus(focusedProductCount).map((panel) => panel.id))
  return SIDE_BY_SIDE_PANELS
    .filter((panel) => shown.has(panel.id) || panel.hiddenForSingleProduct)
    .map((panel) => ({ panel, withheld: !shown.has(panel.id) }))
}
