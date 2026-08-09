import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}))

import { HeadOfficeCreateBranchDialog } from "./head-office-create-branch-dialog"

describe("HeadOfficeCreateBranchDialog", () => {
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
      <HeadOfficeCreateBranchDialog organizationId={12} onCreated={onCreated} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Create Branch" }))
    expect(screen.queryByRole("combobox")).toBeNull()

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

  it("disables creation when the user has no organization assignment", () => {
    render(
      <HeadOfficeCreateBranchDialog organizationId={null} onCreated={vi.fn()} />,
    )

    expect((screen.getByRole("button", { name: "Create Branch" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
