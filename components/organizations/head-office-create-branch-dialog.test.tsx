import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}))

import { HeadOfficeCreateBranchDialog } from "./head-office-create-branch-dialog"

const noParents: Array<{ id: number; name: string; status: string | null }> = []

/** Opens a Radix Select by its label and picks one option. */
function choose(label: string, option: string) {
  fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, ctrlKey: false, pointerType: "mouse" })
  fireEvent.click(screen.getByRole("option", { name: option }))
}

describe("HeadOfficeCreateBranchDialog", () => {
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

  it("submits only the Head Office user's fixed organization", async () => {
    const onCreated = vi.fn()
    const createdBranch = {
      id: 77,
      organizationId: 12,
      name: "Lahore Central",
      code: "ORG-03",
      status: "active",
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ item: createdBranch }),
    } as Response)

    render(
      <HeadOfficeCreateBranchDialog organizationId={12} parentOptions={noParents} onCreated={onCreated} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Create Branch" }))
    // No organization picker: the only choice offered is the branch type.
    expect(screen.getAllByRole("combobox").map((box) => box.id)).toEqual(["head-office-branch-hierarchy"])

    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "  Lahore Central  " },
    })
    fireEvent.change(screen.getByLabelText("Province"), {
      target: { value: "Punjab" },
    })
    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Lahore" },
    })
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "1 Mall Road" },
    })
    fireEvent.change(screen.getByLabelText("Cost center ID"), {
      target: { value: " CC-12 " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Branch" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, request] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(request?.body))).toEqual({
      organizationId: 12,
      name: "Lahore Central",
      province: "Punjab",
      city: "Lahore",
      address: "1 Mall Road",
      costCenterId: "CC-12",
      headCount: null,
      contactPhone: null,
      hierarchyRole: "STANDALONE",
      parentBranchId: null,
      status: "active",
    })
    expect(request).toMatchObject({
      method: "POST",
      credentials: "include",
    })

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdBranch))
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Branch created",
      variant: "success",
    }))
  })

  it("sends the head count when one is given, and refuses a malformed one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ item: { id: 78, organizationId: 12, name: "Multan" } }),
    } as Response)

    render(<HeadOfficeCreateBranchDialog organizationId={12} parentOptions={noParents} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Create Branch" }))
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "Multan" } })
    fireEvent.change(screen.getByLabelText("Province"), { target: { value: "Punjab" } })
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Multan" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "2 Cantt Road" } })

    const save = screen.getByRole("button", { name: "Save Branch" }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText("Head count"), { target: { value: "-3" } })
    expect(save.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText("Head count"), { target: { value: "42" } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, request] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(request?.body))).toMatchObject({ headCount: 42 })
  })

  it("sends the contact phone normalised, and refuses one that is not a phone number", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ item: { id: 80, organizationId: 12, name: "Saddar" } }),
    } as Response)

    render(<HeadOfficeCreateBranchDialog organizationId={12} parentOptions={noParents} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Create Branch" }))
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "Saddar" } })
    fireEvent.change(screen.getByLabelText("Province"), { target: { value: "Sindh" } })
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Karachi" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "3 Zaibunnisa Street" } })

    const save = screen.getByRole("button", { name: "Save Branch" }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText("Contact phone"), { target: { value: "call the manager" } })
    expect(save.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText("Contact phone"), { target: { value: "  0300   1234567 " } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ contactPhone: "0300 1234567" })
  })

  it("disables creation when the user has no organization assignment", () => {
    render(
      <HeadOfficeCreateBranchDialog organizationId={null} parentOptions={noParents} onCreated={vi.fn()} />,
    )

    expect((screen.getByRole("button", { name: "Create Branch" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("creates a child of a chosen parent, and will not submit a child without one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ item: { id: 79, organizationId: 12, name: "Gulberg" } }),
    } as Response)

    render(
      <HeadOfficeCreateBranchDialog
        organizationId={12}
        parentOptions={[{ id: 5, name: "Lahore Head Branch", status: "active" }]}
        onCreated={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Create Branch" }))
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "Gulberg" } })
    fireEvent.change(screen.getByLabelText("Province"), { target: { value: "Punjab" } })
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Lahore" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "3 Main Boulevard" } })

    choose("Branch type", "Child")
    const save = screen.getByRole("button", { name: "Save Branch" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(screen.getByText("Choose the parent branch.")).toBeTruthy()

    choose("Parent branch", "Lahore Head Branch")
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ hierarchyRole: "CHILD", parentBranchId: 5 })
  })

  it("says so when the organization has no parent branch to choose", () => {
    render(<HeadOfficeCreateBranchDialog organizationId={12} parentOptions={noParents} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Create Branch" }))
    choose("Branch type", "Child")

    expect(screen.getByText(/has no parent branch yet/)).toBeTruthy()
  })
})
