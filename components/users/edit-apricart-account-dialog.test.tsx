import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { EditApricartAccountDialog } from "./edit-apricart-account-dialog"

const account = {
  id: "0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4",
  fullName: "Sana Desk",
  firstName: "Sana",
  lastName: "Desk",
  email: "sana@example.test",
  username: "sana.desk",
  phone: null,
}

const fetchMock = vi.fn()

function renderDialog() {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(<EditApricartAccountDialog account={account} noun="desk user" onClose={onClose} onSaved={onSaved} />)
  return { onClose, onSaved }
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function sentBody() {
  const [url, init] = fetchMock.mock.calls[0]
  return { url, method: init.method, body: JSON.parse(init.body) }
}

describe("EditApricartAccountDialog", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("shows the account's details and sends only what changed", async () => {
    const { onClose, onSaved } = renderDialog()
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("sana.desk")
    type("Email", "sana.new@example.test")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sentBody()).toEqual({
      url: `/api/v1/users/${account.id}`,
      method: "PATCH",
      body: { email: "sana.new@example.test" },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it("sets a new password only once it meets the policy and matches", async () => {
    const { onSaved } = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }))
    type("New password", "weak")
    type("Confirm new password", "weak")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByRole("alert").textContent).toMatch(/at least 12/)
    expect(fetchMock).not.toHaveBeenCalled()

    type("New password", "N3w-Passw0rd!x")
    type("Confirm new password", "N3w-Passw0rd!x")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sentBody().body).toEqual({ password: "N3w-Passw0rd!x" })
  })

  it("sends no password once the reset is withdrawn", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }))
    type("New password", "N3w-Passw0rd!x")
    fireEvent.click(screen.getByRole("button", { name: "Keep current password" }))
    type("Phone (optional)", "0300 1234567")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody().body).toEqual({ phone: "0300 1234567" })
  })

  it("shows the server's refusal and stays open", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Username already in use by another user" }), { status: 400 }))
    const { onClose, onSaved } = renderDialog()
    type("Username", "taken.name")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Username already in use by another user")
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("refuses to send when nothing changed", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByRole("alert").textContent).toBe("Nothing has changed")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
