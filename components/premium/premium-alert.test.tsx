import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PremiumAlert } from "./premium-alert"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("PremiumAlert", () => {
  it("does not write debug output while rendering", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const onClose = vi.fn()
    const { rerender } = render(
      <PremiumAlert
        message="Company created"
        isVisible={false}
        onClose={onClose}
      />,
    )

    rerender(
      <PremiumAlert
        message="Company created"
        isVisible
        onClose={onClose}
      />,
    )

    expect(consoleLog).not.toHaveBeenCalled()
  })
})
