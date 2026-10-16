import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

window.HTMLElement.prototype.scrollIntoView = vi.fn()
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    json: async () => ({ available: true, suggestions: [] }),
  }),
)

const mockAppContext = vi.hoisted(() => ({
  organizationId: "12",
  branchId: "",
  userRole: "HEAD_OFFICE",
  isInitialized: true,
}))

vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data:
      key === "/api/v1/organizations"
        ? {
            items: [
              {
                id: 12,
                name: "Apricart Pakistan",
              },
            ],
          }
        : undefined,
  }),
}))

vi.mock("@/components/context/app-context", () => ({
  useAppContext: () => mockAppContext,
}))

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}))

vi.mock("@/lib/fetcher", () => ({
  jsonFetcher: vi.fn().mockResolvedValue({}),
}))

import { CreateUserDialog } from "@/components/users/create-user-dialog"
import { jsonFetcher } from "@/lib/fetcher"

describe("CreateUserDialog", () => {
  afterEach(() => {
    cleanup()
    mockAppContext.userRole = "HEAD_OFFICE"
  })

  it("keeps entered values when close is requested and the user chooses to continue editing", async () => {
    render(<CreateUserDialog />)

    fireEvent.click(screen.getByRole("button", { name: "Create User" }))

    const firstNameInput = await screen.findByLabelText(/^First Name/)
    fireEvent.change(firstNameInput, {
      target: {
        value: "Unsaved QA User",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(
      await screen.findByRole("alertdialog", {
        name: "Discard unsaved user details?",
      }),
    ).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))

    await waitFor(() => {
      expect((screen.getByLabelText(/^First Name/) as HTMLInputElement).value).toBe(
        "Unsaved QA User",
      )
    })
  })

  it("closes only after the user explicitly discards dirty form state", async () => {
    render(<CreateUserDialog />)

    fireEvent.click(screen.getByRole("button", { name: "Create User" }))
    fireEvent.change(await screen.findByLabelText(/^First Name/), {
      target: {
        value: "Discard Me",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    )

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Create User" })).toBeNull()
    })
  })

  it("shows the assigned organization name on the Role & Assignment step", async () => {
    render(<CreateUserDialog />)

    fireEvent.click(screen.getByRole("button", { name: "Create User" }))
    fireEvent.change(await screen.findByLabelText(/^First Name/), {
      target: { value: "Assigned" },
    })
    fireEvent.change(screen.getByLabelText(/^Last Name/), {
      target: { value: "User" },
    })
    fireEvent.change(screen.getByLabelText(/^Email Address/), {
      target: { value: "assigned.user@example.com" },
    })
    fireEvent.change(screen.getByLabelText(/^Username/), {
      target: { value: "assigned.user" },
    })
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: "StrongPassword1!" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))

    expect(
      await screen.findByText("Apricart Pakistan"),
    ).not.toBeNull()
  })

  it("shows the organization's prefix and checks the username it will really get", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    render(<CreateUserDialog />)
    fireEvent.click(screen.getByRole("button", { name: "Create User" }))

    // "Apricart Pakistan" → ap-
    expect(await screen.findByText("ap-")).not.toBeNull()
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "Ali.Khan" } })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/users/check-username?username=ap-ali.khan")
    })
  })

  it("shows an off-by-default budget allocation switch only for Group User", async () => {
    render(<CreateUserDialog />)
    fireEvent.click(screen.getByRole("button", { name: "Create User" }))
    fireEvent.change(await screen.findByLabelText(/^First Name/), { target: { value: "Budget" } })
    fireEvent.change(screen.getByLabelText(/^Last Name/), { target: { value: "User" } })
    fireEvent.change(screen.getByLabelText(/^Email Address/), { target: { value: "budget.user@example.com" } })
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "budget.user" } })
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "StrongPassword1!" } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))

    expect(screen.queryByLabelText("Budget Allocation")).toBeNull()
    const roleSelect = document.querySelector('[name="role"]')
    fireEvent.keyDown(roleSelect as Element, { key: "Enter" })
    fireEvent.click(await screen.findByRole("option", { name: "Group User", hidden: true }))

    const budgetSwitch = await screen.findByLabelText("Budget Allocation")
    expect(budgetSwitch.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(budgetSwitch)
    expect(budgetSwitch.getAttribute("aria-checked")).toBe("true")
  })

  it("visually distinguishes the disabled Next button on step 2", async () => {
    render(<CreateUserDialog />)

    fireEvent.click(screen.getByRole("button", { name: "Create User" }))
    fireEvent.change(await screen.findByLabelText(/^First Name/), {
      target: { value: "Disabled" },
    })
    fireEvent.change(screen.getByLabelText(/^Last Name/), {
      target: { value: "State" },
    })
    fireEvent.change(screen.getByLabelText(/^Email Address/), {
      target: { value: "disabled.state@example.com" },
    })
    fireEvent.change(screen.getByLabelText(/^Username/), {
      target: { value: "disabled.state" },
    })
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: "StrongPassword1!" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))

    const nextButton = await screen.findByRole("button", { name: "Next" })
    expect((nextButton as HTMLButtonElement).disabled).toBe(true)
    expect(nextButton.getAttribute("class")).toContain("disabled:bg-muted")
    expect(nextButton.getAttribute("class")).toContain(
      "disabled:text-muted-foreground",
    )
    expect(nextButton.getAttribute("class")).toContain("disabled:opacity-100")
  })

  it("does not show a previous success message when reopened", async () => {
    mockAppContext.userRole = "SUPER_ADMIN"
    render(<CreateUserDialog />)

    fireEvent.click(screen.getByRole("button", { name: "Create User" }))
    fireEvent.change(await screen.findByLabelText(/^First Name/), {
      target: { value: "First" },
    })
    fireEvent.change(screen.getByLabelText(/^Last Name/), {
      target: { value: "User" },
    })
    fireEvent.change(screen.getByLabelText(/^Email Address/), {
      target: { value: "first.user@example.com" },
    })
    fireEvent.change(screen.getByLabelText(/^Username/), {
      target: { value: "first.user" },
    })
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: "StrongPassword1!" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))

    const roleSelect = document.querySelector('[name="role"]')
    expect(roleSelect).not.toBeNull()
    fireEvent.keyDown(roleSelect as Element, { key: "Enter" })
    fireEvent.click(
      await screen.findByRole("option", { name: "Head Office", hidden: true }),
    )
    const nextButton = screen.getByRole("button", { name: "Next" })
    await waitFor(() => {
      expect((nextButton as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(nextButton)

    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Create User" }))
    expect(await screen.findByText("User created successfully.")).not.toBeNull()

    await waitFor(
      () => {
        expect(screen.queryByRole("dialog")).toBeNull()
      },
      { timeout: 3000 },
    )

    fireEvent.click(screen.getByRole("button", { name: "Create User" }))
    await screen.findByLabelText(/^First Name/)

    expect(screen.queryByText("User created successfully.")).toBeNull()
  })

  it("sends the optional designation, trimmed, with the new user", async () => {
    mockAppContext.userRole = "SUPER_ADMIN"
    vi.mocked(jsonFetcher).mockClear()
    render(<CreateUserDialog />)

    fireEvent.click(screen.getByRole("button", { name: "Create User" }))
    fireEvent.change(await screen.findByLabelText(/^First Name/), { target: { value: "Titled" } })
    fireEvent.change(screen.getByLabelText(/^Last Name/), { target: { value: "User" } })
    fireEvent.change(screen.getByLabelText(/^Email Address/), { target: { value: "titled.user@example.com" } })
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "titled.user" } })
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "StrongPassword1!" } })
    fireEvent.change(screen.getByLabelText("Designation"), { target: { value: "  Procurement Manager " } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))

    fireEvent.keyDown(document.querySelector('[name="role"]') as Element, { key: "Enter" })
    fireEvent.click(await screen.findByRole("option", { name: "Head Office", hidden: true }))
    const nextButton = screen.getByRole("button", { name: "Next" })
    await waitFor(() => expect((nextButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(nextButton)
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Create User" }))

    await waitFor(() => expect(vi.mocked(jsonFetcher)).toHaveBeenCalledWith("/api/v1/users", expect.anything()))
    const [, init] = vi.mocked(jsonFetcher).mock.calls.find(([url]) => url === "/api/v1/users")!
    expect(JSON.parse(String((init as RequestInit).body)).designation).toBe("Procurement Manager")
  })
})
