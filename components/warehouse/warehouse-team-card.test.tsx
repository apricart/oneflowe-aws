import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const swr = vi.hoisted(() => ({ data: undefined as unknown, mutate: vi.fn() }))

vi.mock("swr", () => ({
  default: (key: string) => {
    if (key !== "/api/v1/warehouse-team") throw new Error(`unexpected key ${key}`)
    return { data: swr.data, error: undefined, isLoading: false, mutate: swr.mutate }
  },
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { WarehouseTeamCard } from "./warehouse-team-card"

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= vi.fn()

const organizations = [
  { id: 1, name: "Meezan", code: "MEZ", status: "active" },
  { id: 2, name: "UBL", code: "UBL", status: "active" },
]
const branches = [
  { id: 11, organizationId: 1, name: "North", city: "Lahore", cityKey: "lahore", status: "active" },
  { id: 12, organizationId: 1, name: "South", city: "karachi", cityKey: "karachi", status: "inactive" },
  { id: 13, organizationId: 1, name: "Saddar", city: "Karachi", cityKey: "karachi", status: "active" },
  { id: 21, organizationId: 2, name: "Clifton", city: "Karachi", cityKey: "karachi", status: "active" },
]
const cities = [
  {
    key: "karachi",
    label: "Karachi",
    branchCount: 3,
    organizationCount: 2,
    organizations: [{ organizationId: 1, branchCount: 2 }, { organizationId: 2, branchCount: 1 }],
  },
  { key: "lahore", label: "Lahore", branchCount: 1, organizationCount: 1, organizations: [{ organizationId: 1, branchCount: 1 }] },
]

const member = (overrides: Record<string, unknown> = {}) => ({
  id: "0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4",
  fullName: "Kamran Store",
  username: "kamran.wh",
  email: "kamran@example.test",
  isActive: true,
  branchIds: [11, 21],
  cityKeys: [],
  cityOrganizationIds: [],
  ...overrides,
})

const team = (members: unknown[]) => ({ members, organizations, branches, cities })

const fetchMock = vi.fn()

const openDialog = () => {
  fireEvent.click(screen.getByRole("button", { name: "Branches" }))
  return screen.getByRole("dialog")
}

// Radix tabs switch on mouse down, not click.
const showTab = (dialog: HTMLElement, name: string) => {
  fireEvent.mouseDown(within(dialog).getByRole("tab", { name }), { button: 0, ctrlKey: false })
}

const sentBody = (call: number) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body))

beforeEach(() => {
  fetchMock.mockReset()
  swr.mutate.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Warehouse team", () => {
  it("lists each warehouse user with the cities and branches they serve", () => {
    swr.data = team([
      member(),
      member({ id: "x", fullName: "Nadia", branchIds: [] }),
      member({ id: "y", fullName: "Bilal", branchIds: [11], cityKeys: ["karachi"], cityOrganizationIds: [1, 2] }),
      member({ id: "z", fullName: "Sana", branchIds: [], cityKeys: ["karachi"], cityOrganizationIds: [2] }),
      member({ id: "w", fullName: "Omar", branchIds: [], cityKeys: ["karachi"], cityOrganizationIds: [] }),
    ])
    render(<WarehouseTeamCard />)
    expect(within(screen.getByText("Kamran Store").closest("tr")!).getByText("2 branches — Meezan, UBL")).toBeTruthy()
    expect(within(screen.getByText("Nadia").closest("tr")!).getByText("None")).toBeTruthy()
    expect(within(screen.getByText("Bilal").closest("tr")!).getByText("Karachi · 4 branches — Meezan, UBL")).toBeTruthy()
    // A city reaches only the chosen organizations' branches, and nothing without one.
    expect(within(screen.getByText("Sana").closest("tr")!).getByText("Karachi · 1 branch — UBL")).toBeTruthy()
    expect(within(screen.getByText("Omar").closest("tr")!).getByText("Karachi · no organization chosen")).toBeTruthy()
  })

  it("says so when there is no warehouse account yet", () => {
    swr.data = team([])
    render(<WarehouseTeamCard />)
    expect(screen.getByText("No warehouse accounts yet.")).toBeTruthy()
  })

  describe("by city, in two steps", () => {
    const ok = () => new Response(JSON.stringify({ item: {} }), { status: 200 })

    it("opens on the organizations and lists no city until one is chosen", () => {
      swr.data = team([member()])
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      expect(within(dialog).getByRole("tab", { name: "By city" }).getAttribute("aria-selected")).toBe("true")
      expect(within(dialog).getByRole("heading", { name: "1. Organizations" })).toBeTruthy()
      expect(within(dialog).getByLabelText(/Meezan/)).toBeTruthy()
      expect(within(dialog).getByLabelText(/UBL/)).toBeTruthy()
      expect(within(dialog).getByText("0 organizations chosen.")).toBeTruthy()
      expect(within(dialog).getByText("Choose an organization first; its cities are listed here.")).toBeTruthy()
      expect(within(dialog).queryByLabelText(/Karachi/)).toBeNull()
    })

    it("chooses an organization with one request, then offers only its cities, counted within it", async () => {
      swr.data = team([member()])
      let finish: (value: Response) => void = () => {}
      fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()

      const ubl = within(dialog).getByLabelText(/UBL/)
      fireEvent.click(ubl)
      fireEvent.click(ubl)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/warehouse-team/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4/city-organizations")
      expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT")
      expect(sentBody(0)).toEqual({ organizationId: 2, assigned: true })

      finish(ok())
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
      expect(within(dialog).getByText("1 organization chosen.")).toBeTruthy()
      // UBL has a branch in Karachi only.
      expect(within(dialog).getByLabelText(/Karachi/)).toBeTruthy()
      expect(within(dialog).getByText("1 branch · 1 organization")).toBeTruthy()
      expect(within(dialog).queryByLabelText(/Lahore/)).toBeNull()
    })

    it("sums a city over every chosen organization", () => {
      swr.data = team([member({ cityOrganizationIds: [1, 2] })])
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      expect(within(dialog).getByText("3 branches · 2 organizations")).toBeTruthy()
      expect(within(dialog).getByText("1 branch · 1 organization")).toBeTruthy()
    })

    it("assigns a city of a chosen organization with one request naming its key", async () => {
      swr.data = team([member({ cityOrganizationIds: [1] })])
      fetchMock.mockResolvedValueOnce(ok())
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      fireEvent.click(within(dialog).getByLabelText(/Karachi/))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
      expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/warehouse-team/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4/cities")
      expect(sentBody(0)).toEqual({ city: "karachi", assigned: true })
      expect(within(dialog).getByText("1 city assigned.")).toBeTruthy()
    })

    it("withdraws an organization and keeps its cities, offering one now outside them only to withdraw it", async () => {
      swr.data = team([member({ cityKeys: ["lahore"], cityOrganizationIds: [1] })])
      fetchMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
      render(<WarehouseTeamCard />)
      const dialog = openDialog()

      fireEvent.click(within(dialog).getByLabelText(/Meezan/))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
      expect(sentBody(0)).toEqual({ organizationId: 1, assigned: false })
      expect(within(dialog).getByText("1 city assigned.")).toBeTruthy()
      expect(within(dialog).getByText("not in the chosen organizations")).toBeTruthy()

      fireEvent.click(within(dialog).getByLabelText(/Lahore/))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(2))
      expect(sentBody(1)).toEqual({ city: "lahore", assigned: false })
      expect(within(dialog).getByText("0 cities assigned.")).toBeTruthy()
    })

    it("keeps the city unchanged with the server's reason when refused", async () => {
      swr.data = team([member({ cityOrganizationIds: [1] })])
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "No branch of the chosen organizations is in that city" }), { status: 400 }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      fireEvent.click(within(dialog).getByLabelText(/Lahore/))
      expect(await within(dialog).findByText("No branch of the chosen organizations is in that city")).toBeTruthy()
      expect(within(dialog).getByText("0 cities assigned.")).toBeTruthy()
      expect(swr.mutate).not.toHaveBeenCalled()
    })

    it("keeps the organization unchanged with the server's reason when refused", async () => {
      swr.data = team([member()])
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "The organization does not exist" }), { status: 400 }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      fireEvent.click(within(dialog).getByLabelText(/Meezan/))
      expect(await within(dialog).findByText("The organization does not exist")).toBeTruthy()
      expect(within(dialog).getByText("0 organizations chosen.")).toBeTruthy()
      expect(swr.mutate).not.toHaveBeenCalled()
    })
  })

  describe("select all / unselect all", () => {
    const saved = (item: Record<string, unknown>) => new Response(JSON.stringify({ item }), { status: 200 })

    it("chooses every organization not yet chosen with one request, and keeps the server's answer", async () => {
      swr.data = team([member({ cityOrganizationIds: [1] })])
      fetchMock.mockResolvedValueOnce(saved({ organizationIds: [1, 2] }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()

      fireEvent.click(within(dialog).getByRole("button", { name: "Select all (1)" }))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/warehouse-team/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4/city-organizations")
      expect(sentBody(0)).toEqual({ organizationIds: [2], assigned: true })
      expect(within(dialog).getByText("2 organizations chosen.")).toBeTruthy()
      expect((within(dialog).getByRole("button", { name: "Select all (0)" }) as HTMLButtonElement).disabled).toBe(true)
    })

    it("acts only on the organizations the filter shows", async () => {
      swr.data = team([member()])
      fetchMock.mockResolvedValueOnce(saved({ organizationIds: [2] }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      fireEvent.change(within(dialog).getByLabelText("Filter organizations"), { target: { value: "ub" } })
      fireEvent.click(within(dialog).getByRole("button", { name: "Select all shown (1)" }))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
      expect(sentBody(0)).toEqual({ organizationIds: [2], assigned: true })
    })

    it("asks before withdrawing every organization, and sends nothing when kept", async () => {
      swr.data = team([member({ cityOrganizationIds: [1, 2] })])
      fetchMock.mockResolvedValueOnce(saved({ organizationIds: [] }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()

      fireEvent.click(within(dialog).getByRole("button", { name: "Unselect all (2)" }))
      fireEvent.click(await screen.findByRole("button", { name: "Keep them" }))
      expect(fetchMock).not.toHaveBeenCalled()

      fireEvent.click(within(dialog).getByRole("button", { name: "Unselect all (2)" }))
      expect(await screen.findByText("Withdraw 2 organizations?")).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Withdraw" }))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
      expect(sentBody(0)).toEqual({ organizationIds: [1, 2], assigned: false })
      expect(within(dialog).getByText("0 organizations chosen.")).toBeTruthy()
    })

    it("assigns every city of the chosen organizations, never one outside them", async () => {
      // Lahore is assigned but outside the chosen organization; Karachi is not yet assigned.
      swr.data = team([member({ cityKeys: ["lahore"], cityOrganizationIds: [2] })])
      fetchMock.mockResolvedValueOnce(saved({ cityKeys: ["karachi", "lahore"] }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()

      fireEvent.click(within(dialog).getByRole("button", { name: "Assign all (1)" }))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
      expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/warehouse-team/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4/cities")
      expect(sentBody(0)).toEqual({ cities: ["karachi"], assigned: true })
      expect(within(dialog).getByText("2 cities assigned.")).toBeTruthy()
    })

    it("asks before unassigning every city, including one outside the chosen organizations", async () => {
      swr.data = team([member({ cityKeys: ["karachi", "lahore"], cityOrganizationIds: [2] })])
      fetchMock.mockResolvedValueOnce(saved({ cityKeys: [] }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()

      fireEvent.click(within(dialog).getByRole("button", { name: "Unassign all (2)" }))
      expect(await screen.findByText("Unassign 2 cities?")).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Unassign" }))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
      expect(sentBody(0)).toEqual({ cities: ["karachi", "lahore"], assigned: false })
      expect(within(dialog).getByText("0 cities assigned.")).toBeTruthy()
    })

    it("keeps the reach unchanged with the server's reason when refused", async () => {
      swr.data = team([member({ cityOrganizationIds: [1] })])
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "A warehouse user can be assigned at most 200 cities" }), { status: 409 }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      fireEvent.click(within(dialog).getByRole("button", { name: "Assign all (2)" }))
      expect(await within(dialog).findByText("A warehouse user can be assigned at most 200 cities")).toBeTruthy()
      expect(within(dialog).getByText("0 cities assigned.")).toBeTruthy()
      expect(swr.mutate).not.toHaveBeenCalled()
    })
  })

  describe("by branch", () => {
    it("searches organizations before switching the branch list", () => {
      swr.data = team([member()])
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      showTab(dialog, "By branch")

      fireEvent.click(within(dialog).getByRole("combobox", { name: "Organization" }))
      fireEvent.change(screen.getByLabelText("Search organizations"), { target: { value: "ubl" } })
      fireEvent.click(screen.getByRole("option", { name: /UBL/ }))

      expect(within(dialog).getByLabelText(/Clifton/)).toBeTruthy()
      expect(within(dialog).queryByLabelText(/North/)).toBeNull()
    })

    it("selects only filtered branches and preserves hidden selections", async () => {
      swr.data = team([member({ branchIds: [11] })])
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ item: {} }), { status: 200 }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      showTab(dialog, "By branch")

      fireEvent.change(within(dialog).getByLabelText("Filter branches"), { target: { value: "south" } })
      fireEvent.click(within(dialog).getByRole("button", { name: "Select all shown" }))
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(sentBody(0)).toEqual({ organizationId: 1, branchIds: [11, 12] })
    })

    it("replaces one organization's branches with what is ticked, once, and refreshes", async () => {
      swr.data = team([member()])
      let finish: (value: Response) => void = () => {}
      fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      showTab(dialog, "By branch")

      // Opens on the first organization with an assigned branch, and only its branches.
      expect(within(dialog).getByLabelText(/North/)).toBeTruthy()
      expect(within(dialog).queryByLabelText(/Clifton/)).toBeNull()
      expect(within(dialog).getByText("inactive")).toBeTruthy()

      fireEvent.click(within(dialog).getByLabelText(/South/))
      const save = within(dialog).getByRole("button", { name: "Save" })
      fireEvent.click(save)
      fireEvent.click(save)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe("/api/v1/warehouse-team/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4/branches")
      expect((init as RequestInit).method).toBe("PUT")
      expect(sentBody(0)).toEqual({ organizationId: 1, branchIds: [11, 12] })

      finish(new Response(JSON.stringify({ item: {} }), { status: 200 }))
      await waitFor(() => expect(swr.mutate).toHaveBeenCalledTimes(1))
    })

    it("offers Save only once something changed", () => {
      swr.data = team([member()])
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      showTab(dialog, "By branch")
      const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement
      expect(save.disabled).toBe(true)
    })

    it("shows a branch an assigned city covers as served and leaves it out of the bulk action", async () => {
      swr.data = team([member({ branchIds: [11], cityKeys: ["karachi"], cityOrganizationIds: [1] })])
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ item: {} }), { status: 200 }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      showTab(dialog, "By branch")

      const south = within(dialog).getByLabelText(/South/)
      expect(south.getAttribute("aria-checked")).toBe("true")
      expect((south as HTMLButtonElement).disabled).toBe(true)
      expect(within(dialog).getAllByText("via Karachi")).toHaveLength(2)
      expect(within(dialog).getByText("3 of 3 served in this organization (2 through a city).")).toBeTruthy()

      // North is the only branch no city covers: unselecting all withdraws just it.
      fireEvent.click(within(dialog).getByRole("button", { name: "Unselect all" }))
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(sentBody(0)).toEqual({ organizationId: 1, branchIds: [] })
    })

    it("does not count a city for an organization that is not chosen for it", () => {
      swr.data = team([member({ branchIds: [11], cityKeys: ["karachi"], cityOrganizationIds: [2] })])
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      showTab(dialog, "By branch")
      const south = within(dialog).getByLabelText(/South/)
      expect(south.getAttribute("aria-checked")).toBe("false")
      expect((south as HTMLButtonElement).disabled).toBe(false)
      expect(within(dialog).queryByText("via Karachi")).toBeNull()
      expect(within(dialog).getByText("1 of 3 served in this organization.")).toBeTruthy()
    })

    it("keeps the dialog open with the server's reason when refused", async () => {
      swr.data = team([member()])
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "One or more branches do not belong to this organization" }), { status: 400 }))
      render(<WarehouseTeamCard />)
      const dialog = openDialog()
      showTab(dialog, "By branch")
      fireEvent.click(within(dialog).getByLabelText(/North/))
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))
      expect(await screen.findByText("One or more branches do not belong to this organization")).toBeTruthy()
      expect(swr.mutate).not.toHaveBeenCalled()
    })
  })
})
