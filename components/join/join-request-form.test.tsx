import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { JoinRequestForm, type JoinFormOptions } from "./join-request-form"

const OPTIONS: JoinFormOptions = {
  organizationName: "K-Electric",
  emailDomain: "ke.com.pk",
  branches: [{ id: 7, name: "North" }],
  groups: [],
}

function renderForm(onSubmit = vi.fn(async (_payload: Record<string, unknown>) => {})) {
  render(<JoinRequestForm options={OPTIONS} onSubmit={onSubmit} onBack={vi.fn()} />)
  return onSubmit
}

/** Every required field, so each test can spoil exactly one. */
function fillValidForm(emailLocalPart = "Ada.Lovelace") {
  fireEvent.change(screen.getByLabelText(/^First name/), { target: { value: "Ada" } })
  fireEvent.change(screen.getByLabelText(/^Last name/), { target: { value: "Lovelace" } })
  fireEvent.change(screen.getByLabelText(/^Work email/), { target: { value: emailLocalPart } })
  fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "ada" } })
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "Join-Flow-2026!x" } })
  fireEvent.change(screen.getByLabelText(/^Confirm password/), {
    target: { value: "Join-Flow-2026!x" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Order Initiator" }))
  fireEvent.change(screen.getByLabelText(/^Branch/), { target: { value: "7" } })
}

async function send() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send request" }))
  })
}

afterEach(() => {
  cleanup()
})

describe("JoinRequestForm — the email is locked to the organization's domain", () => {
  it("shows the domain as a fixed suffix the applicant cannot edit", () => {
    renderForm()

    const email = screen.getByLabelText(/^Work email/) as HTMLInputElement
    const suffix = screen.getByText("@ke.com.pk")

    // The suffix is text, not a field: there is exactly one input for the email.
    expect(suffix.tagName).not.toBe("INPUT")
    expect(email.value).toBe("")
    // Screen readers hear the domain as part of the field's description.
    expect(email.getAttribute("aria-describedby")).toContain(suffix.id)
    // Not type="email": the browser must not demand a full address here.
    expect(email.getAttribute("type")).not.toBe("email")
  })

  it("sends the typed part joined to the domain, lower-cased", async () => {
    const onSubmit = renderForm()
    fillValidForm("  Ada.Lovelace ")
    await send()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      email: "ada.lovelace@ke.com.pk",
      role: "ORDER_PORTAL",
      branchId: 7,
    })
  })

  it("refuses an @ in the field rather than rewriting the address", async () => {
    // `ada@gmail.com` must not quietly become `ada@ke.com.pk` — that may be a
    // different person's mailbox.
    const onSubmit = renderForm()
    fillValidForm("ada@gmail.com")
    await send()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/only the part before the @/i)).toBeTruthy()
    expect(screen.getByLabelText(/^Work email/).getAttribute("aria-invalid")).toBe("true")
  })

  it("refuses an empty email and a malformed one", async () => {
    const onSubmit = renderForm()
    fillValidForm("")
    await send()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/enter your email address/i)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/^Work email/), { target: { value: "ada..l" } })
    await send()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/letters, numbers/i)).toBeTruthy()
  })

  it("shows the server's refusal when the address is turned away there", async () => {
    const onSubmit = vi.fn(async (_payload: Record<string, unknown>) => {
      throw new Error("Use your @ke.com.pk email address to join.")
    })
    renderForm(onSubmit)
    fillValidForm("ada")
    await send()

    expect(screen.getByRole("alert").textContent).toContain("Use your @ke.com.pk email address")
  })
})
