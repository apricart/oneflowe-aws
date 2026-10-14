import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  mutateOrganizations: vi.fn(),
  mutateBranches: vi.fn(),
  role: "SUPER_ADMIN",
}))

vi.mock("@/lib/hooks/use-api", () => ({
  useOrganizations: () => ({
    data: {
      items: [
        {
          id: 1,
          name: "Zomato",
          code: "0001",
          status: "active",
          budgetAllocationMode: "money",
          emailDomain: "zomato.com",
        },
        {
          id: 2,
          name: "Panacloud",
          code: "0002",
          status: "active",
          budgetAllocationMode: "money",
          blockOrderingOnUnpaidInvoices: true,
          blockOrderingOnUnacknowledgedDeliveries: true,
          unpaidInvoiceBlockThreshold: 5,
          unacknowledgedDeliveryBlockThreshold: 3,
          budgetsEnabled: false,
        },
      ],
    },
    mutate: mocks.mutateOrganizations,
    isLoading: false,
  }),
  useBranches: () => ({
    data: {
      items: [
        { id: 11, name: "Zomato Branch", code: "ZB", organizationId: 1, status: "active" },
        { id: 22, name: "Panacloud Branch", code: "PB", organizationId: 2, status: "active" },
      ],
    },
    mutate: mocks.mutateBranches,
  }),
}))

vi.mock("@/components/context/app-context", () => ({
  useAppContext: () => ({ organizationId: "1" }),
}))

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { role: mocks.role } } }),
}))

import OrganizationsPage from "./page"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.role = "SUPER_ADMIN"
})

describe("OrganizationsPage organization selection", () => {
  it("keeps a clicked organization selected when a global organization context exists", () => {
    render(<OrganizationsPage />)

    expect(screen.getByText("0001 • 1 branch")).toBeTruthy()
    expect(screen.getByText("0002 • 1 branch")).toBeTruthy()
    expect(screen.queryByText(/1 branches/i)).toBeNull()

    const panacloudItem = screen.getByRole("button", { name: /Panacloud 0002/ })
    expect(panacloudItem).not.toBeNull()
    expect(panacloudItem?.className).toContain("border-transparent")

    fireEvent.click(panacloudItem!)

    expect(panacloudItem?.className).toContain("border-indigo-500/30")
    expect(screen.getAllByText("Panacloud")).toHaveLength(2)
    expect(screen.getByText("Panacloud Branch")).toBeTruthy()
  })

  it("visually distinguishes the disabled Save Company button", () => {
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))

    const saveButton = screen.getByRole("button", { name: "Save Company" })
    expect((saveButton as HTMLButtonElement).disabled).toBe(true)
    expect(saveButton.getAttribute("class")).toContain("disabled:bg-muted")
    expect(saveButton.getAttribute("class")).toContain(
      "disabled:text-muted-foreground",
    )
    expect(saveButton.getAttribute("class")).toContain("disabled:opacity-100")
    expect(saveButton.getAttribute("class")).toContain("disabled:shadow-none")

    fireEvent.change(screen.getByLabelText("Company name"), {
      target: { value: "Acme Inc." },
    })
    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "ACME" },
    })

    expect((saveButton as HTMLButtonElement).disabled).toBe(false)
  })

  it("provides an accessible description for the Create Company dialog", () => {
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))

    const dialog = screen.getByRole("dialog", { name: "Create Company" })
    const descriptionId = dialog.getAttribute("aria-describedby")

    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId!)?.textContent).toContain(
      "Set up a new tenant with a memorable code, status, and budget allocation model.",
    )
  })

  it("defaults to requiring approval and disables approver selection when switched off", () => {
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))

    const approvalSwitch = screen.getByRole("switch", { name: "Require order approval" })
    expect((approvalSwitch as HTMLButtonElement).getAttribute("data-state")).toBe("checked")

    fireEvent.click(approvalSwitch)

    expect((approvalSwitch as HTMLButtonElement).getAttribute("data-state")).toBe("unchecked")
    expect((screen.getByRole("button", { name: /Branch Admin/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("Saved for use if approval is required again later.")).toBeTruthy()
  })
})

/** A JSON reply the page's plain `fetch` calls can read. */
function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/**
 * Every request the dialogs make, answered by URL and method, with the calls
 * recorded so a test can read back exactly what was sent.
 */
function stubOrganizationApi(options: { approvalLevels?: { status: number; body: unknown } } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === "/api/v1/organizations" && method === "POST") {
      return reply(201, { item: { id: 3, name: "Acme Inc.", code: "ACME" } })
    }
    if (url.startsWith("/api/v1/settings") && method === "GET") return reply(200, { data: [] })
    if (url.endsWith("/network-policy") && method === "GET") {
      return reply(200, { enabled: false, entries: [] })
    }
    if (url.endsWith("/approval-levels") && method === "GET") {
      const answer = options.approvalLevels ?? { status: 200, body: { enabled: false, levels: [] } }
      return reply(answer.status, answer.body)
    }
    return reply(200, { ok: true })
  })
  vi.stubGlobal("fetch", fetchMock)
  return calls
}

describe("OrganizationsPage email domain", () => {
  it("refuses a malformed domain in Create Company and sends a valid one normalised", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } })
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "ACME" } })

    const saveButton = screen.getByRole("button", { name: "Save Company" }) as HTMLButtonElement
    const domain = screen.getByLabelText("Email domain (optional)")

    fireEvent.change(domain, { target: { value: "not a domain" } })
    expect(screen.getByText(/domain such as example\.com/)).toBeTruthy()
    expect(domain.getAttribute("aria-invalid")).toBe("true")
    expect(saveButton.disabled).toBe(true)

    fireEvent.change(domain, { target: { value: " @Acme.COM " } })
    expect(saveButton.disabled).toBe(false)

    fireEvent.click(saveButton)
    const confirm = await screen.findByRole("alertdialog")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Create Company" }))
    })

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations" && call.method === "POST"))
        .toBe(true)
    })
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.emailDomain).toBe("acme.com")
  })

  it("leaves the domain out of Create Company when it is blank", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } })
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "ACME" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Company" }))

    const confirm = await screen.findByRole("alertdialog")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Create Company" }))
    })

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body).not.toHaveProperty("emailDomain")
  })

  it("prefills Edit Company with the stored domain and clears it with null", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    // The first organization in the list is Zomato, which has a domain.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const domain = within(dialog).getByLabelText("Email domain (optional)") as HTMLInputElement
    expect(domain.value).toBe("zomato.com")

    fireEvent.change(domain, { target: { value: "" } })
    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH"))
        .toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")!
    expect(patch.body.emailDomain).toBeNull()
  })

  it("keeps Save Changes disabled while the edited domain is malformed", async () => {
    stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))

    fireEvent.change(within(dialog).getByLabelText("Email domain (optional)"), {
      target: { value: "name@zomato.com" },
    })
    expect(save.disabled).toBe(true)
    expect(within(dialog).getByText(/without a name or @/)).toBeTruthy()
  })
})

describe("OrganizationsPage unpaid-invoice ordering block", () => {
  const TOGGLE = "Block ordering on unpaid invoices"

  async function createCompany() {
    fireEvent.click(screen.getByRole("button", { name: "Save Company" }))
    const confirm = await screen.findByRole("alertdialog")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Create Company" }))
    })
  }

  it("is off by default in Create Company and is sent as false", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    const toggle = screen.getByRole("switch", { name: TOGGLE })
    expect(toggle.getAttribute("data-state")).toBe("unchecked")
    expect(screen.getByText(/2 or more unpaid invoices/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } })
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "ACME" } })
    await createCompany()

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.blockOrderingOnUnpaidInvoices).toBe(false)
  })

  it("sends true from Create Company when switched on", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    fireEvent.click(screen.getByRole("switch", { name: TOGGLE }))
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } })
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "ACME" } })
    await createCompany()

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.blockOrderingOnUnpaidInvoices).toBe(true)
  })

  it("Edit Company shows the stored value and sends the change", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    // Zomato (first) has the block off; switch it on.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const toggle = within(dialog).getByRole("switch", { name: TOGGLE })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(toggle.getAttribute("data-state")).toBe("unchecked")

    fireEvent.click(toggle)
    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")).toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")!
    expect(patch.body.blockOrderingOnUnpaidInvoices).toBe(true)
  })

  it("Edit Company prefills an organization that already blocks", async () => {
    stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    expect(within(dialog).getByRole("switch", { name: TOGGLE }).getAttribute("data-state")).toBe("checked")
  })

  it("a Head Office user neither sees nor sends the toggle", async () => {
    mocks.role = "HEAD_OFFICE"
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    expect(within(dialog).queryByRole("switch", { name: TOGGLE })).toBeNull()

    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")).toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")!
    expect(patch.body).not.toHaveProperty("blockOrderingOnUnpaidInvoices")
  })
})

describe("OrganizationsPage unacknowledged-delivery ordering block", () => {
  const TOGGLE = "Block ordering on unacknowledged deliveries"
  const UNPAID_TOGGLE = "Block ordering on unpaid invoices"

  async function createCompany() {
    fireEvent.click(screen.getByRole("button", { name: "Save Company" }))
    const confirm = await screen.findByRole("alertdialog")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Create Company" }))
    })
  }

  function nameTheCompany() {
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } })
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "ACME" } })
  }

  it("is off by default in Create Company, says what it counts, and is sent as false", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    expect(screen.getByRole("switch", { name: TOGGLE }).getAttribute("data-state")).toBe("unchecked")
    expect(screen.getByText(/2 or more orders that are delivered but not yet acknowledged/)).toBeTruthy()

    nameTheCompany()
    await createCompany()

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.blockOrderingOnUnacknowledgedDeliveries).toBe(false)
  })

  it("sends true from Create Company when switched on, independently of the unpaid-invoice toggle", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    fireEvent.click(screen.getByRole("switch", { name: TOGGLE }))
    expect(screen.getByRole("switch", { name: UNPAID_TOGGLE }).getAttribute("data-state")).toBe("unchecked")
    nameTheCompany()
    await createCompany()

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.blockOrderingOnUnacknowledgedDeliveries).toBe(true)
    expect(created.body.blockOrderingOnUnpaidInvoices).toBe(false)
  })

  it("Edit Company shows the stored value and sends the change", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    // Zomato (first) has the block off; switch it on.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const toggle = within(dialog).getByRole("switch", { name: TOGGLE })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(toggle.getAttribute("data-state")).toBe("unchecked")

    fireEvent.click(toggle)
    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")).toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")!
    expect(patch.body.blockOrderingOnUnacknowledgedDeliveries).toBe(true)
  })

  it("Edit Company prefills an organization that already blocks, and switching it off sends false", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const toggle = within(dialog).getByRole("switch", { name: TOGGLE })
    expect(toggle.getAttribute("data-state")).toBe("checked")
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(toggle)
    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/2" && call.method === "PATCH")).toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/2" && call.method === "PATCH")!
    expect(patch.body.blockOrderingOnUnacknowledgedDeliveries).toBe(false)
  })

  it("a Head Office user neither sees nor sends the toggle", async () => {
    mocks.role = "HEAD_OFFICE"
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    expect(within(dialog).queryByRole("switch", { name: TOGGLE })).toBeNull()

    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")).toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")!
    expect(patch.body).not.toHaveProperty("blockOrderingOnUnacknowledgedDeliveries")
  })
})

describe("OrganizationsPage budget allocation switch", () => {
  const TOGGLE = "Budget allocation"

  function nameTheCompany() {
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } })
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "ACME" } })
  }

  async function saveEdit(dialog: HTMLElement) {
    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })
  }

  it("is off by default in Create Company, hides the model, and is sent as false", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    expect(screen.getByRole("switch", { name: TOGGLE }).getAttribute("data-state")).toBe("unchecked")
    expect(screen.queryByRole("button", { name: /Money value/ })).toBeNull()
    expect(screen.getByText(/When off, orders are placed without a budget/)).toBeTruthy()

    nameTheCompany()
    fireEvent.click(screen.getByRole("button", { name: "Save Company" }))
    const confirm = await screen.findByRole("alertdialog")
    // The confirmation says what will actually happen, not a model that will not.
    expect(within(confirm).getByText(/will order without budget allocation/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Create Company" }))
    })

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.budgetsEnabled).toBe(false)
  })

  it("shows the model once switched on and sends both", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    fireEvent.click(screen.getByRole("switch", { name: TOGGLE }))
    const quantity = screen.getByRole("button", { name: /Quantity/ })
    fireEvent.click(quantity)
    expect(quantity.getAttribute("aria-pressed")).toBe("true")
    nameTheCompany()
    fireEvent.click(screen.getByRole("button", { name: "Save Company" }))
    const confirm = await screen.findByRole("alertdialog")
    expect(within(confirm).getByText(/will use quantity-based budget allocation/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Create Company" }))
    })

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.budgetsEnabled).toBe(true)
    expect(created.body.budgetAllocationMode).toBe("quantity")
  })

  it("Edit Company reads a record without the field as on — never hides a live budget — and sends a switch-off", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const toggle = within(dialog).getByRole("switch", { name: TOGGLE })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(toggle.getAttribute("data-state")).toBe("checked")

    fireEvent.click(toggle)
    expect(within(dialog).getByText(/Orders already holding budget keep it until they are decided/)).toBeTruthy()
    await saveEdit(dialog)

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")).toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")!
    expect(patch.body.budgetsEnabled).toBe(false)
  })

  it("Edit Company prefills an organization with budgets off and sends a switch-on", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const toggle = within(dialog).getByRole("switch", { name: TOGGLE })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(toggle.getAttribute("data-state")).toBe("unchecked")
    expect(within(dialog).queryByRole("button", { name: /Money value/ })).toBeNull()

    fireEvent.click(toggle)
    expect(within(dialog).getByRole("button", { name: /Money value/ })).toBeTruthy()
    await saveEdit(dialog)

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/2" && call.method === "PATCH")).toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/2" && call.method === "PATCH")!
    expect(patch.body.budgetsEnabled).toBe(true)
  })

  it("marks an organization with budgets off in the list rather than naming a model", () => {
    stubOrganizationApi()
    render(<OrganizationsPage />)

    expect(screen.getAllByText("Budget off")).toHaveLength(1)
  })

  it("a Head Office user neither sees nor sends the switch", async () => {
    mocks.role = "HEAD_OFFICE"
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    expect(within(dialog).queryByRole("switch", { name: TOGGLE })).toBeNull()
    await saveEdit(dialog)

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")).toBe(true)
    })
    const patch = calls.find((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")!
    expect(patch.body).not.toHaveProperty("budgetsEnabled")
  })
})

// plans/OF-ORDERING-BLOCK-configurable-thresholds.md
describe("OrganizationsPage ordering-block limits", () => {
  const UNPAID_TOGGLE = "Block ordering on unpaid invoices"
  const UNACKNOWLEDGED_TOGGLE = "Block ordering on unacknowledged deliveries"
  const UNPAID_LIMIT = "Unpaid invoices that stop ordering"
  const UNACKNOWLEDGED_LIMIT = "Unacknowledged deliveries that stop ordering"
  const RANGE = "Enter a whole number from 1 to 100."

  async function createCompany() {
    fireEvent.click(screen.getByRole("button", { name: "Save Company" }))
    const confirm = await screen.findByRole("alertdialog")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Create Company" }))
    })
  }

  function openCreate() {
    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } })
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "ACME" } })
  }

  async function openEdit(index: number) {
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[index])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    return { dialog, save }
  }

  async function patchSentFor(calls: ReturnType<typeof stubOrganizationApi>, id: number) {
    await waitFor(() => {
      expect(calls.some((call) => call.url === `/api/v1/organizations/${id}` && call.method === "PATCH")).toBe(true)
    })
    return calls.find((call) => call.url === `/api/v1/organizations/${id}` && call.method === "PATCH")!.body
  }

  it("Create Company shows a limit only while its block is on, starting at 2", () => {
    stubOrganizationApi()
    render(<OrganizationsPage />)
    openCreate()

    expect(screen.queryByLabelText(UNPAID_LIMIT)).toBeNull()
    expect(screen.queryByLabelText(UNACKNOWLEDGED_LIMIT)).toBeNull()

    fireEvent.click(screen.getByRole("switch", { name: UNPAID_TOGGLE }))
    const limit = screen.getByLabelText(UNPAID_LIMIT) as HTMLInputElement
    expect(limit.value).toBe("2")
    expect(limit.getAttribute("min")).toBe("1")
    expect(limit.getAttribute("max")).toBe("100")
    expect(screen.queryByLabelText(UNACKNOWLEDGED_LIMIT)).toBeNull()

    fireEvent.click(screen.getByRole("switch", { name: UNPAID_TOGGLE }))
    expect(screen.queryByLabelText(UNPAID_LIMIT)).toBeNull()
  })

  it("Create Company sends the chosen limits, and the hint prints the number being typed", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)
    openCreate()

    fireEvent.click(screen.getByRole("switch", { name: UNPAID_TOGGLE }))
    fireEvent.change(screen.getByLabelText(UNPAID_LIMIT), { target: { value: "5" } })
    expect(screen.getByText(/A branch with 5 or more unpaid invoices/)).toBeTruthy()

    fireEvent.click(screen.getByRole("switch", { name: UNACKNOWLEDGED_TOGGLE }))
    fireEvent.change(screen.getByLabelText(UNACKNOWLEDGED_LIMIT), { target: { value: "1" } })
    expect(screen.getByText(/A branch with 1 or more orders that are delivered/)).toBeTruthy()

    await createCompany()
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!.body
    expect(created).toMatchObject({
      blockOrderingOnUnpaidInvoices: true,
      unpaidInvoiceBlockThreshold: 5,
      blockOrderingOnUnacknowledgedDeliveries: true,
      unacknowledgedDeliveryBlockThreshold: 1,
    })
  })

  it("Create Company with both blocks off still sends the default limits", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)
    openCreate()
    await createCompany()

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!.body
    expect(created.unpaidInvoiceBlockThreshold).toBe(2)
    expect(created.unacknowledgedDeliveryBlockThreshold).toBe(2)
  })

  it.each(["0", "101", "1.5", ""])("Create Company refuses %j while the block is on, and says why", (value) => {
    stubOrganizationApi()
    render(<OrganizationsPage />)
    openCreate()
    const save = screen.getByRole("button", { name: "Save Company" }) as HTMLButtonElement
    expect(save.disabled).toBe(false)

    fireEvent.click(screen.getByRole("switch", { name: UNPAID_TOGGLE }))
    const limit = screen.getByLabelText(UNPAID_LIMIT)
    fireEvent.change(limit, { target: { value } })

    expect(screen.getByRole("alert").textContent).toBe(RANGE)
    expect(limit.getAttribute("aria-invalid")).toBe("true")
    expect(limit.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id)
    expect(screen.getByText(/reaches the limit below in unpaid invoices/)).toBeTruthy()
    expect(save.disabled).toBe(true)

    fireEvent.change(limit, { target: { value: "3" } })
    expect(screen.queryByRole("alert")).toBeNull()
    expect(save.disabled).toBe(false)
  })

  it("an invalid limit on a block that is switched off neither blocks Save nor is sent", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)
    openCreate()

    fireEvent.click(screen.getByRole("switch", { name: UNPAID_TOGGLE }))
    fireEvent.change(screen.getByLabelText(UNPAID_LIMIT), { target: { value: "0" } })
    fireEvent.click(screen.getByRole("switch", { name: UNPAID_TOGGLE }))

    const save = screen.getByRole("button", { name: "Save Company" }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await createCompany()
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!.body
    expect(created.blockOrderingOnUnpaidInvoices).toBe(false)
    expect(created).not.toHaveProperty("unpaidInvoiceBlockThreshold")
    expect(created.unacknowledgedDeliveryBlockThreshold).toBe(2)
  })

  it("Edit Company prefills the stored limits and sends a change", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    // Panacloud (second) blocks on both, at 5 and 3.
    const { dialog, save } = await openEdit(1)
    const unpaid = within(dialog).getByLabelText(UNPAID_LIMIT) as HTMLInputElement
    const unacknowledged = within(dialog).getByLabelText(UNACKNOWLEDGED_LIMIT) as HTMLInputElement
    expect(unpaid.value).toBe("5")
    expect(unacknowledged.value).toBe("3")
    expect(within(dialog).getByText(/A branch with 5 or more unpaid invoices/)).toBeTruthy()
    expect(within(dialog).getByText(/A branch with 3 or more orders that are delivered/)).toBeTruthy()

    fireEvent.change(unpaid, { target: { value: "10" } })
    await act(async () => {
      fireEvent.click(save)
    })
    const patch = await patchSentFor(calls, 2)
    expect(patch).toMatchObject({ unpaidInvoiceBlockThreshold: 10, unacknowledgedDeliveryBlockThreshold: 3 })
  })

  it("Edit Company refuses an invalid limit while the block is on", async () => {
    stubOrganizationApi()
    render(<OrganizationsPage />)

    const { dialog, save } = await openEdit(1)
    fireEvent.change(within(dialog).getByLabelText(UNACKNOWLEDGED_LIMIT), { target: { value: "0" } })
    expect(within(dialog).getByRole("alert").textContent).toBe(RANGE)
    expect(save.disabled).toBe(true)
  })

  it("Edit Company reads an organization with no stored limit as the default 2", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    // Zomato (first) carries no limit fields and blocks on neither.
    const { dialog, save } = await openEdit(0)
    fireEvent.click(within(dialog).getByRole("switch", { name: UNPAID_TOGGLE }))
    expect((within(dialog).getByLabelText(UNPAID_LIMIT) as HTMLInputElement).value).toBe("2")

    await act(async () => {
      fireEvent.click(save)
    })
    const patch = await patchSentFor(calls, 1)
    expect(patch).toMatchObject({ blockOrderingOnUnpaidInvoices: true, unpaidInvoiceBlockThreshold: 2, unacknowledgedDeliveryBlockThreshold: 2 })
  })

  it("a Head Office user neither sees nor sends either limit", async () => {
    mocks.role = "HEAD_OFFICE"
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    const { dialog, save } = await openEdit(1)
    expect(within(dialog).queryByLabelText(UNPAID_LIMIT)).toBeNull()
    expect(within(dialog).queryByLabelText(UNACKNOWLEDGED_LIMIT)).toBeNull()
    await act(async () => {
      fireEvent.click(save)
    })
    const patch = await patchSentFor(calls, 2)
    expect(patch).not.toHaveProperty("unpaidInvoiceBlockThreshold")
    expect(patch).not.toHaveProperty("unacknowledgedDeliveryBlockThreshold")
  })
})

// plans/OF-APPROVAL-LEVELS-organization-approval-levels.md
describe("OrganizationsPage order approval levels", () => {
  const TOGGLE = "Order approval levels"

  function nameTheCompany() {
    fireEvent.change(screen.getByLabelText("Company name"), { target: { value: "Acme Inc." } })
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "ACME" } })
  }

  /** Opens the confirmation, hands it to `inspect` before it is answered, then confirms. */
  async function confirmCreate(inspect: (confirm: HTMLElement) => void = () => undefined) {
    fireEvent.click(screen.getByRole("button", { name: "Save Company" }))
    const confirm = await screen.findByRole("alertdialog")
    inspect(confirm)
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Create Company" }))
    })
  }

  async function openEdit(index: number) {
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[index])
    const dialog = await screen.findByRole("dialog", { name: "Edit Company" })
    const save = within(dialog).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement
    return { dialog, save }
  }

  const putsTo = (calls: ReturnType<typeof stubOrganizationApi>, id: number) =>
    calls.filter((call) => call.url === `/api/v1/organizations/${id}/approval-levels` && call.method === "PUT")

  it("is off by default in Create Company and is sent as off", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    expect(screen.getByRole("switch", { name: TOGGLE }).getAttribute("data-state")).toBe("unchecked")
    expect(screen.queryByLabelText("Level 1 approver")).toBeNull()

    nameTheCompany()
    await confirmCreate()

    await waitFor(() => expect(calls.some((call) => call.url === "/api/v1/organizations")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.orderApprovalLevels).toEqual({ enabled: false })
  })

  it("Create Company shows Level 1 when switched on, adds levels, refuses a level no higher than the one before, and sends cents", async () => {
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    fireEvent.click(screen.getByRole("button", { name: "Create Company" }))
    nameTheCompany()
    fireEvent.click(screen.getByRole("switch", { name: TOGGLE }))
    const save = screen.getByRole("button", { name: "Save Company" }) as HTMLButtonElement

    // Level 1 is there at once; Save waits for its amount.
    expect(screen.getByLabelText("Level 1 approver")).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Level 1 approver"), { target: { value: "40,000" } })
    expect(save.disabled).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: /add approver level/i }))
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Level 2 approver"), { target: { value: "40000" } })
    expect(screen.getByText("Level 2's amount must be higher than Level 1's (PKR 40,000.00).")).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Level 2 approver"), { target: { value: "80000.50" } })
    expect(save.disabled).toBe(false)

    await confirmCreate((confirm) => {
      expect(within(confirm).getByText(/It will have 2 order approval levels\./)).toBeTruthy()
    })

    await waitFor(() => expect(calls.some((call) => call.url === "/api/v1/organizations")).toBe(true))
    const created = calls.find((call) => call.url === "/api/v1/organizations")!
    expect(created.body.orderApprovalLevels).toEqual({
      enabled: true,
      levels: [{ maxAmountCents: 4_000_000 }, { maxAmountCents: 8_000_050 }],
    })
  })

  it("Edit Company prefills the stored levels and sends a change", async () => {
    const calls = stubOrganizationApi({
      approvalLevels: {
        status: 200,
        body: { enabled: true, levels: [{ level: 1, maxAmountCents: 4_000_000 }, { level: 2, maxAmountCents: 8_000_000 }] },
      },
    })
    render(<OrganizationsPage />)

    const { dialog, save } = await openEdit(0)
    await waitFor(() => expect(save.disabled).toBe(false))
    expect(within(dialog).getByRole("switch", { name: TOGGLE }).getAttribute("data-state")).toBe("checked")
    expect((within(dialog).getByLabelText("Level 1 approver") as HTMLInputElement).value).toBe("40000")
    expect((within(dialog).getByLabelText("Level 2 approver") as HTMLInputElement).value).toBe("80000")

    fireEvent.click(within(dialog).getByRole("button", { name: /add approver level/i }))
    fireEvent.change(within(dialog).getByLabelText("Level 3 approver"), { target: { value: "150000" } })
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => expect(putsTo(calls, 1)).toHaveLength(1))
    expect(putsTo(calls, 1)[0].body).toEqual({
      enabled: true,
      levels: [{ maxAmountCents: 4_000_000 }, { maxAmountCents: 8_000_000 }, { maxAmountCents: 15_000_000 }],
    })
  })

  it("Edit Company switching off sends no levels, so the stored ones are kept", async () => {
    const calls = stubOrganizationApi({
      approvalLevels: { status: 200, body: { enabled: true, levels: [{ level: 1, maxAmountCents: 4_000_000 }] } },
    })
    render(<OrganizationsPage />)

    const { dialog, save } = await openEdit(0)
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(within(dialog).getByRole("switch", { name: TOGGLE }))
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => expect(putsTo(calls, 1)).toHaveLength(1))
    expect(putsTo(calls, 1)[0].body).toEqual({ enabled: false })
  })

  it("Edit Company leaves the levels alone when they cannot be loaded, and says so", async () => {
    const calls = stubOrganizationApi({ approvalLevels: { status: 500, body: { error: "boom" } } })
    render(<OrganizationsPage />)

    const { dialog, save } = await openEdit(0)
    expect(await within(dialog).findByText(/Order approval levels could not be loaded/)).toBeTruthy()
    expect(within(dialog).queryByRole("switch", { name: TOGGLE })).toBeNull()
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")).toBe(true)
    })
    expect(putsTo(calls, 1)).toHaveLength(0)
  })

  it("a Head Office user neither sees, reads nor sends the levels", async () => {
    mocks.role = "HEAD_OFFICE"
    const calls = stubOrganizationApi()
    render(<OrganizationsPage />)

    const { dialog, save } = await openEdit(0)
    expect(within(dialog).queryByRole("switch", { name: TOGGLE })).toBeNull()
    await waitFor(() => expect(save.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/organizations/1" && call.method === "PATCH")).toBe(true)
    })
    expect(calls.some((call) => call.url.endsWith("/approval-levels"))).toBe(false)
  })
})
