import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const useAPI = vi.fn()
vi.mock("@/lib/hooks/use-api", () => ({ useAPI: (...args: unknown[]) => useAPI(...args) }))

import { WarehouseSupportLink } from "@/components/warehouse/warehouse-support-link"

afterEach(() => {
  cleanup()
  useAPI.mockReset()
})

describe("the warehouse menu's support link", () => {
  it("opens the shared support area and reads the scoped support stats", () => {
    useAPI.mockReturnValue({ data: undefined })
    render(<WarehouseSupportLink />)
    expect(screen.getByRole("link", { name: /Support/ }).getAttribute("href")).toBe("/support")
    expect(useAPI.mock.calls[0][0]).toBe("/api/v1/support/stats")
  })

  it("shows no badge while nothing is unread or nothing has loaded", () => {
    useAPI.mockReturnValue({ data: { unread: 0 } })
    render(<WarehouseSupportLink />)
    expect(screen.queryByLabelText(/unread messages/)).toBeNull()
  })

  it("counts the threads with unread messages, capped for display", () => {
    useAPI.mockReturnValue({ data: { unread: 3 } })
    const { unmount } = render(<WarehouseSupportLink />)
    expect(screen.getByLabelText("3 support requests with unread messages").textContent).toBe("3")
    unmount()

    useAPI.mockReturnValue({ data: { unread: 150 } })
    render(<WarehouseSupportLink />)
    expect(screen.getByLabelText("150 support requests with unread messages").textContent).toBe("99+")
  })
})
