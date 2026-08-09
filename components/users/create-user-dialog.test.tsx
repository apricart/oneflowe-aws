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
})
