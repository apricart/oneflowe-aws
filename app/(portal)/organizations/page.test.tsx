import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  mutateOrganizations: vi.fn(),
  mutateBranches: vi.fn(),
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
        { id: 2, name: "Panacloud", code: "0002", status: "active", budgetAllocationMode: "money" },
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
  useSession: () => ({ data: { user: { role: "SUPER_ADMIN" } } }),
}))

import OrganizationsPage from "./page"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
})

/** A JSON reply the page's plain `fetch` calls can read. */
function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/**
 * Every request the dialogs make, answered by URL and method, with the calls
 * recorded so a test can read back exactly what was sent.
 */
function stubOrganizationApi() {
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
