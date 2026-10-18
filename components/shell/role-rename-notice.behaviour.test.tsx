import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { resetUi, ui } from "@/tests/support/ui-mocks"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())

import { RoleRenameNotice } from "@/components/shell/role-rename-notice"
import { isRoleRenameNoticeDue, markRoleRenameNoticeDue } from "@/lib/role-rename-notice"

/**
 * The notice a person sees on their landing page after signing in: shown only
 * when the sign-in marked it due, naming the renames for their role, and gone
 * for the rest of the session once closed.
 */
beforeEach(() => {
  sessionStorage.clear()
})

function renameRows(): string[] {
  const dialog = screen.getByRole("dialog")
  // Each row is old name, arrow, the screen-reader words, new name — read part by part.
  return within(dialog).getAllByRole("listitem").map((item) =>
    Array.from(item.children).map((part) => part.textContent?.trim()).filter(Boolean).join(" "))
}

describe("RoleRenameNotice", () => {
  it("stays hidden when no sign-in has marked it due", () => {
    resetUi({ role: "HEAD_OFFICE", id: "u-1" })
    render(<RoleRenameNotice />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("says first that only the names changed and nothing else is affected", async () => {
    resetUi({ role: "HEAD_OFFICE", id: "u-1" })
    markRoleRenameNoticeDue()
    render(<RoleRenameNotice />)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("This is only a name change.")).toBeTruthy()
    expect(within(dialog).getByText(/Nothing else is affected\. Your work stays exactly the same as before/)).toBeTruthy()
  })

  it("shows Head Office all four renames, old name, arrow, new name", async () => {
    resetUi({ role: "HEAD_OFFICE", id: "u-1" })
    markRoleRenameNoticeDue()
    render(<RoleRenameNotice />)
    await screen.findByRole("dialog")
    expect(renameRows()).toEqual([
      "Branch Admin is now called Financial Approver",
      "Order Portal is now called Order Initiator",
      "Group User is now called Group Financial Approver",
      "Group Order Portal is now called Group Order Initiator",
    ])
  })

  it.each(["GROUP_USER", "GROUP_ORDER_PORTAL"])("shows %s the two group renames only", async (role) => {
    resetUi({ role, id: "u-1" })
    markRoleRenameNoticeDue()
    render(<RoleRenameNotice />)
    await screen.findByRole("dialog")
    expect(renameRows()).toEqual([
      "Group User is now called Group Financial Approver",
      "Group Order Portal is now called Group Order Initiator",
    ])
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL"])("shows %s the two branch renames only", async (role) => {
    resetUi({ role, id: "u-1" })
    markRoleRenameNoticeDue()
    render(<RoleRenameNotice />)
    await screen.findByRole("dialog")
    expect(renameRows()).toEqual([
      "Branch Admin is now called Financial Approver",
      "Order Portal is now called Order Initiator",
    ])
  })

  it("closes on Got it and does not come back in this session", async () => {
    resetUi({ role: "ORDER_PORTAL", id: "u-1" })
    markRoleRenameNoticeDue()
    const { unmount } = render(<RoleRenameNotice />)
    fireEvent.click(await screen.findByRole("button", { name: "Got it" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(isRoleRenameNoticeDue()).toBe(false)

    unmount()
    render(<RoleRenameNotice />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("closed with the X also counts as seen", async () => {
    resetUi({ role: "BRANCH_ADMIN", id: "u-1" })
    markRoleRenameNoticeDue()
    render(<RoleRenameNotice />)
    fireEvent.click(await screen.findByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(isRoleRenameNoticeDue()).toBe(false)
  })

  it("waits for a signed-in session before showing", () => {
    resetUi({ role: "HEAD_OFFICE", id: "u-1" })
    ui.sessionStatus = "loading"
    markRoleRenameNoticeDue()
    render(<RoleRenameNotice />)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(isRoleRenameNoticeDue()).toBe(true)
  })
})
