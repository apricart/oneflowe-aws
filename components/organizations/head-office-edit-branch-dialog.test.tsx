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

const parents = [{ id: 5, name: "Lahore Head Branch", status: "active" }]

/** Opens a Radix Select by its label and picks one option. */
function choose(label: string, option: string) {
  fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, ctrlKey: false, pointerType: "mouse" })
  fireEvent.click(screen.getByRole("option", { name: option }))
}

describe("HeadOfficeEditBranchDialog", () => {
  beforeAll(() => {
    // Radix Select needs layout APIs jsdom does not implement.
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.hasPointerCapture = vi.fn(() => false)
    Element.prototype.releasePointerCapture = vi.fn()
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

    render(<HeadOfficeEditBranchDialog branch={branch} parentOptions={parents} onSaved={onSaved} />)
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

    render(<HeadOfficeEditBranchDialog branch={branch} parentOptions={parents} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))
    fireEvent.change(screen.getByLabelText("Head count"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ headCount: null })
  })

  it("sends nothing when nothing changed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")

    render(<HeadOfficeEditBranchDialog branch={branch} parentOptions={parents} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("will not submit a malformed head count", () => {
    render(<HeadOfficeEditBranchDialog branch={branch} parentOptions={parents} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))
    fireEvent.change(screen.getByLabelText("Head count"), { target: { value: "2.5" } })

    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("sends the type and its parent together when the type changes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ item: branch }),
    } as Response)

    render(<HeadOfficeEditBranchDialog branch={branch} parentOptions={parents} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))
    choose("Branch type", "Child")
    choose("Parent branch", "Lahore Head Branch")
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ hierarchyRole: "CHILD", parentBranchId: 5 })
  })

  it("clears the parent when a child is made standalone", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ item: branch }),
    } as Response)
    const child = { ...branch, hierarchyRole: "CHILD", parentBranchId: 5 }

    render(<HeadOfficeEditBranchDialog branch={child} parentOptions={parents} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))
    choose("Branch type", "Standalone")
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ hierarchyRole: "STANDALONE", parentBranchId: null })
  })

  it("keeps a parent that still has children from changing type", () => {
    const parent = { ...branch, hierarchyRole: "PARENT" }
    render(<HeadOfficeEditBranchDialog branch={parent} parentOptions={[]} hasChildren onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Branch" }))

    expect((screen.getByLabelText("Branch type") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/has child branches/)).toBeTruthy()
  })
})
