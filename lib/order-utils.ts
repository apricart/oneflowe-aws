export const AUTO_APPROVAL_WINDOW_MS = 1000 * 60 * 60 * 2 // 2 hours

export const STATUS_FLOW = [
  { key: "pending", label: "Pending review", description: "Awaiting approval by the organization's assigned approver." },
  { key: "approved", label: "Active", description: "Order cleared for branch processing." },
  { key: "fulfilled", label: "Fulfilled", description: "Branch completed the order and delivery." },
  { key: "refunded", label: "Refunded", description: "Finance has issued a refund for this order." },
] as const

type OrderLike = { status: string; createdAt: string }

/**
 * Get auto-approval metadata for an order
 */
export function getAutoApproveMeta(order: OrderLike | null) {
  try {
    // Validate input
    if (!order) {
      return null
    }

    if (!order.status || typeof order.status !== 'string') {
      console.error('[OrderUtils] Invalid order status')
      return null
    }

    if (!order.createdAt) {
      console.error('[OrderUtils] Missing createdAt')
      return null
    }

    const status = order.status.toLowerCase()
    if (status !== "pending") {
      return null
    }

    // Validate and parse date
    const createdAt = new Date(order.createdAt).getTime()
    if (isNaN(createdAt)) {
      console.error('[OrderUtils] Invalid createdAt date:', order.createdAt)
      return null
    }

    const now = Date.now()
    const autoApproveAt = createdAt + AUTO_APPROVAL_WINDOW_MS
    const timeLeft = autoApproveAt - now

    // Check for clock skew
    if (createdAt > now + 60000) {  // 1 minute tolerance
      console.warn('[OrderUtils] Order createdAt in future:', new Date(createdAt))
    }

    if (timeLeft <= 0) {
      return {
        title: "Auto-approval queued",
        detail: "This order will be approved automatically any moment now unless action is taken.",
      }
    }

    const totalMinutes = Math.max(1, Math.ceil(timeLeft / 60000))
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    const countdown = hours ? `${hours}h ${minutes}m` : `${minutes}m`

    return {
      title: `Auto approval in ${countdown}`,
      detail: "Review now if you need to stop or amend this request before the system approves it.",
    }
  } catch (error) {
    console.error('[OrderUtils] Error in getAutoApproveMeta:', error)
    return null
  }
}

/**
 * Get auto-approval countdown string
 */
export function getAutoApprovalCountdown(order: OrderLike | null): string | null {
  try {
    if (!order) {
      return null
    }

    const meta = getAutoApproveMeta(order)
    return meta?.title || null
  } catch (error) {
    console.error('[OrderUtils] Error in getAutoApprovalCountdown:', error)
    return null
  }
}

/**
 * Build status timeline for order
 */
export function buildStatusTimeline(
  status: string,
  statusAtRefund?: string | null,
  isPartialRefund?: boolean,
  approvalToken?: string | null
) {
  try {
    // Validate input
    if (!status || typeof status !== 'string') {
      console.error('[OrderUtils] Invalid status:', status)
      // Return default empty timeline
      return STATUS_FLOW.map(step => ({ ...step, state: "upcoming", approvalToken: null }))
    }

    const normalized = status.toLowerCase().trim()

    // Handle cancelled orders
    if (normalized === "cancelled") {
      return [
        {
          key: "pending",
          label: "Pending review",
          description: "Awaited decision.",
          state: "complete",
          approvalToken: null
        },
        {
          key: "cancelled",
          label: "Cancelled",
          description: "Order was cancelled by head office.",
          state: "current",
          approvalToken: null
        },
      ]
    }

    // Find current status in flow
    const activeIndex = STATUS_FLOW.findIndex(step => step.key === normalized)

    // Handle unknown status
    if (activeIndex === -1) {
      console.warn('[OrderUtils] Unknown order status:', status)
      // Return all as upcoming
      return STATUS_FLOW.map((step, index) => ({
        ...step,
        state: index === 0 ? "current" : "upcoming",
        approvalToken: null
      }))
    }

    const idx = activeIndex

    // Build timeline
    return STATUS_FLOW.map((step, index) => {
      let state = "upcoming"
      let label: string = step.label
      let tokenToLink: string | null = null

      // Dynamic label for partial refund
      if (step.key === "refunded" && isPartialRefund) {
        label = "Partially Refunded"
      }

      // Special handling for Refunded state skips
      if (normalized === "refunded" && step.key === "fulfilled") {
        const refundOrigin = statusAtRefund?.toLowerCase()?.trim()
        const wasFulfilled = refundOrigin === "fulfilled"

        if (!wasFulfilled) {
          return { ...step, label, state: "skipped", approvalToken: null }
        }
      }

      if (index < idx) {
        state = "complete"
      } else if (index === idx) {
        // Terminal states should show as complete (green check) rather than current (clock)
        if (["fulfilled", "refunded"].includes(step.key)) {
          state = "complete"
        } else {
          state = "current"
        }
      }

      // Attach token to "Approved" step if present and order reached that stage
      if (step.key === "approved" && (state === "complete" || state === "current") && approvalToken) {
        tokenToLink = approvalToken
      }

      // Highlight Partially Refunded even if order is not fully "refunded"
      if (step.key === "refunded" && isPartialRefund && state === "upcoming") {
        state = "current" // Highlight it as the active additional stage
      }

      // Correction for skipped fulfilled if we relied on index < idx
      if (state === "complete" && step.key === "fulfilled" && normalized === "refunded") {
        const refundOrigin = statusAtRefund?.toLowerCase()?.trim()
        if (refundOrigin && refundOrigin !== "fulfilled") {
          state = "skipped"
        }
      }

      return { ...step, label, state, approvalToken: tokenToLink }
    })
  } catch (error) {
    console.error('[OrderUtils] Error in buildStatusTimeline:', error)
    // Return safe default
    return STATUS_FLOW.map((step, index) => ({
      ...step,
      state: index === 0 ? "current" : "upcoming"
    }))
  }
}

/**
 * Validate order status
 */
export function isValidOrderStatus(status: string): boolean {
  if (!status || typeof status !== 'string') {
    return false
  }

  const normalized = status.toLowerCase().trim()
  const validStatuses = [...STATUS_FLOW.map(s => s.key), 'cancelled']
  return validStatuses.includes(normalized)
}

/**
 * Check if order is in terminal state
 */
export function isTerminalStatus(status: string): boolean {
  if (!status || typeof status !== 'string') {
    return false
  }

  const normalized = status.toLowerCase().trim()
  return ['fulfilled', 'refunded', 'cancelled'].includes(normalized)
}

/**
 * Check if order can be modified
 */
export function canModifyOrder(status: string): boolean {
  if (!status || typeof status !== 'string') {
    return false
  }

  const normalized = status.toLowerCase().trim()
  return normalized === 'pending'
}

