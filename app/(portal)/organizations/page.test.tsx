import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  mutateOrganizations: vi.fn(),
  mutateBranches: vi.fn(),
}))

vi.mock("@/lib/hooks/use-api", () => ({
  useOrganizations: () => ({
    data: {
      items: [
        { id: 1, name: "Zomato", code: "0001", status: "active", budgetAllocationMode: "money" },
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
