import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}))

import { HeadOfficeEditBranchDialog } from "./head-office-edit-branch-dialog"

const branch = {
  id: 31,
  name: "Lahore Central",
  province: "Punjab",
  city: "Lahore",
  address: "1 Mall Road",
  costCenterId: "CC-1",
  headCount: 12,
}

describe("HeadOfficeEditBranchDialog", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    toastMock.mockReset()
  })

  it("starts from the branch and sends only what changed", async () => {
    const onSaved = vi.fn()
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ item: { ...branch, headCount: 40 } }),
    } as Response)

    render(<HeadOfficeEditBranchDialog branch={branch} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))

    expect((screen.getByLabelText("Head count") as HTMLInputElement).value).toBe("12")
    expect(screen.queryByText("Delivery region")).toBeNull()

    fireEvent.change(screen.getByLabelText("Head count"), { target: { value: "40" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/v1/branches/31")
    expect(request).toMatchObject({ method: "PATCH", credentials: "include" })
    expect(JSON.parse(String(request?.body))).toEqual({ headCount: 40 })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("clears the head count to null when the field is emptied", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ item: branch }),
    } as Response)

    render(<HeadOfficeEditBranchDialog branch={branch} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))
    fireEvent.change(screen.getByLabelText("Head count"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ headCount: null })
  })

  it("sends nothing when nothing changed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")

    render(<HeadOfficeEditBranchDialog branch={branch} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("will not submit a malformed head count", () => {
    render(<HeadOfficeEditBranchDialog branch={branch} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))
    fireEvent.change(screen.getByLabelText("Head count"), { target: { value: "2.5" } })

    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
