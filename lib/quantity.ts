export const QUANTITY_SCALE = 3
export const QUANTITY_EPSILON = 0.0005
export const DEFAULT_DECIMAL_QUANTITY_STEP = 0.1

export const roundQuantity = (value: number) =>
  Math.round((Number(value) + Number.EPSILON) * 1000) / 1000

export const parseQuantity = (value: unknown) => {
  const quantity = typeof value === "number" ? value : Number(value)
  return Number.isFinite(quantity) ? roundQuantity(quantity) : Number.NaN
}

export const isWholeQuantity = (value: number) =>
  Math.abs(roundQuantity(value) - Math.round(roundQuantity(value))) < QUANTITY_EPSILON

export const isValidQuantityStep = (quantity: number, step: number) => {
  const normalizedQuantity = roundQuantity(quantity)
  const normalizedStep = roundQuantity(step)
  if (!Number.isFinite(normalizedQuantity) || !Number.isFinite(normalizedStep) || normalizedStep <= 0) return false

  const quotient = normalizedQuantity / normalizedStep
  return Math.abs(quotient - Math.round(quotient)) < QUANTITY_EPSILON
}

export const sanitizeQuantityStep = (allowDecimalQuantity: boolean, value: unknown) => {
  if (!allowDecimalQuantity) return 1

  const step = parseQuantity(value)
  if (!Number.isFinite(step) || step <= 0) return DEFAULT_DECIMAL_QUANTITY_STEP
  return roundQuantity(step)
}

/**
 * Snap a quantity onto a product's own step grid.
 *
 * Entry controls use this so a typed value is corrected as it is committed
 * rather than accepted and refused later. A positive input never snaps to zero:
 * zero means "remove this line" to every caller, and silently deleting a line
 * the user was editing is worse than rounding it.
 */
export const snapQuantityToStep = (quantity: unknown, step: number) => {
  const parsed = parseQuantity(quantity)
  const normalizedStep = roundQuantity(step)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  if (!Number.isFinite(normalizedStep) || normalizedStep <= 0) return parsed

  return roundQuantity(Math.max(1, Math.round(parsed / normalizedStep)) * normalizedStep)
}

export const validateProductQuantity = (
  quantity: unknown,
  options: {
    allowDecimalQuantity?: boolean | null
    quantityStep?: number | null
    label?: string
    /**
     * Hold a decimal product to its configured step as well.
     *
     * Off by default so every caller that predates this option keeps its exact
     * behaviour: tightening the rule everywhere at once would start refusing
     * quantities the application has always accepted. A caller opts in only
     * where its entry surface already snaps to the same grid, so the rule can
     * reject nothing that surface could have produced.
     */
    enforceStep?: boolean
  } = {},
) => {
  const parsed = parseQuantity(quantity)
  const label = options.label || "Quantity"
  const step = sanitizeQuantityStep(Boolean(options.allowDecimalQuantity), options.quantityStep ?? 1)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false as const, quantity: parsed, error: `${label} must be greater than zero.` }
  }

  if (!options.allowDecimalQuantity && !isWholeQuantity(parsed)) {
    return { ok: false as const, quantity: parsed, error: `${label} must be a whole number for this product.` }
  }

  if ((!options.allowDecimalQuantity || options.enforceStep) && !isValidQuantityStep(parsed, step)) {
    return { ok: false as const, quantity: parsed, error: `${label} must be in increments of ${formatQuantity(step)}.` }
  }

  return { ok: true as const, quantity: parsed, step }
}

export const formatQuantity = (value: unknown, maximumFractionDigits = QUANTITY_SCALE) => {
  const quantity = parseQuantity(value)
  if (!Number.isFinite(quantity)) return "0"

  return quantity.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  })
}

export const calculateLineCents = (priceCents: number, quantity: number) =>
  Math.round(Number(priceCents || 0) * roundQuantity(quantity))
