import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const swr = vi.hoisted(() => ({ data: undefined as unknown, mutate: vi.fn() }))

vi.mock("swr", () => ({
  default: (key: string) => {
    if (key !== "/api/v1/apricart-executives") throw new Error(`unexpected key ${key}`)
    return { data: swr.data, error: undefined, isLoading: false, mutate: swr.mutate }
  },
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { ExecutiveApproversCard } from "./executive-approvers-card"

const organizations = [
  { id: 4, name: "Meezan", code: "MEZ", status: "active", managedOrdering: true },
  { id: 11, name: "UBL", code: "UBL", status: "active", managedOrdering: false },
  { id: 12, name: "Old Co", code: "OLD", status: "inactive", managedOrdering: true },
]

const executive = (overrides: Record<string, unknown> = {}) => ({
  id: "0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4",
  fullName: "Ayesha Director",
  username: "ayesha.exec",
  email: "ayesha@example.test",
  isActive: true,
  organizationIds: [4],
  ...overrides,
})

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  swr.mutate.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Order approvers", () => {
  it("lists each executive with the organizations they approve for", () => {
    swr.data = { members: [executive(), executive({ id: "x", fullName: "Bilal", organizationIds: [] })], organizations }
    render(<ExecutiveApproversCard />)
    expect(within(screen.getByText("Ayesha Director").closest("tr")!).getByText("Meezan")).toBeTruthy()
    expect(within(screen.getByText("Bilal").closest("tr")!).getByText("None — approves nothing")).toBeTruthy()
  })

  it("says so when there is no executive account yet", () => {
    swr.data = { members: [], organizations }
    render(<ExecutiveApproversCard />)
    expect(screen.getByText("No Apricart Executive accounts yet.")).toBeTruthy()
  })

  it("replaces the organizations with what is ticked, once, and refreshes", async () => {
    swr.data = { members: [executive()], organizations }
    let finish: (value: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
    render(<ExecutiveApproversCard />)
    fireEvent.click(screen.getByRole("button", { name: "Organizations" }))

    const dialog = screen.getByRole("dialog")
    // Marks which organizations the desk works for, and which are inactive.
    expect(within(dialog).getAllByText("Order Desk")).toHaveLength(2)
    expect(within(dialog).getByText("inactive")).toBeTruthy()

    fireEvent.click(within(dialog).getByLabelText(/UBL/))
    fireEvent.click(within(dialog).getByLabelText(/Meezan/))
    const save = within(dialog).getByRole("button", { name: "Save" })
    fireEvent.click(save)
    fireEvent.click(save)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/v1/apricart-executives/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4/organizations")
    expect((init as RequestInit).method).toBe("PUT")
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ organizationIds: [11] })

    finish(new Response(JSON.stringify({ item: {} }), { status: 200 }))
    await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
  })

  it("keeps the dialog open with the server's reason when refused", async () => {
    swr.data = { members: [executive()], organizations }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "One or more organizations do not exist" }), { status: 400 }))
    render(<ExecutiveApproversCard />)
    fireEvent.click(screen.getByRole("button", { name: "Organizations" }))
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }))
    expect(await screen.findByText("One or more organizations do not exist")).toBeTruthy()
    expect(swr.mutate).not.toHaveBeenCalled()
  })
})
