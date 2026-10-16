import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DepartmentSignupForm, type DepartmentSignupOptions } from "./department-signup-form"

/**
 * The department sign-up form (plans/OF-JOIN-department-signup-multi-user.md).
 * The server is the control; this pins that the form asks for one approver per
 * configured level, offers existing branches by name, and sends only what the
 * endpoint accepts.
 */

const OPTIONS: DepartmentSignupOptions = {
  organizationName: "UBL",
  emailDomain: "ubl.com.pk",
  branches: [{ id: 4, name: "Clifton Branch" }, { id: 5, name: "Saddar Branch" }],
  approvalLevels: [
    { level: 1, fromCents: 8_000_000, belowCents: null },
    { level: 2, fromCents: null, belowCents: 8_000_000 },
  ],
}

function renderForm(onSubmit = vi.fn(async (_payload: Record<string, unknown>) => {})) {
  render(<DepartmentSignupForm options={OPTIONS} onSubmit={onSubmit} onBack={vi.fn()} />)
  return onSubmit
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement

function change(id: string, value: string) {
  fireEvent.change(byId(id), { target: { value } })
}

function fillValidForm() {
  change("signup-full-name", "Huzaifa Abid")
  change("signup-email", "Huzaifa.Abid")
  change("signup-phone", "03001234567")
  change("signup-ip-extension", "1234")
  change("signup-employee-id", "E-77")
  change("signup-department", "Finance")
  change("signup-approver-1-email", "first.approver")
  change("signup-approver-1-designation", "Head of Finance")
  change("signup-approver-2-email", "second.approver")
  change("signup-approver-2-designation", "Manager")

  change("signup-crc", "clif")
  fireEvent.click(screen.getByRole("option", { name: "Clifton Branch" }))
  change("signup-crc", "ab-abc-123")
  fireEvent.click(screen.getAllByRole("button", { name: /Add/ })[0])

  change("signup-address", "Plot 1, Clifton, Karachi")
  fireEvent.click(screen.getAllByRole("button", { name: /Add/ })[1])

  change("signup-password", "Str0ng!Password")
  change("signup-confirm-password", "Str0ng!Password")
  fireEvent.click(byId("signup-terms"))
}

async function send() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign Up" }))
  })
}

afterEach(() => {
  cleanup()
})

describe("DepartmentSignupForm", () => {
  it("shows one approver card per configured level, each with its band", () => {
    renderForm()
    expect(byId("signup-approver-1-email")).toBeTruthy()
    expect(byId("signup-approver-2-email")).toBeTruthy()
    expect(byId("signup-approver-3-email")).toBeNull()
    expect(screen.getByText("orders PKR 80,000.00 and above")).toBeTruthy()
    expect(screen.getByText("orders under PKR 80,000.00")).toBeTruthy()
  })

  it("derives the usernames from the emails and offers no role choice", () => {
    renderForm()
    change("signup-email", "Huzaifa.Abid")
    change("signup-approver-1-email", "First.Approver")
    expect(byId("signup-username").value).toBe("huzaifa.abid")
    expect(byId("signup-approver-1-username").value).toBe("first.approver")
    expect(byId("signup-role").value).toBe("Order Initiator")
    expect(byId("signup-role").readOnly).toBe(true)
  })

  it("suggests existing branches by name only, never by a CRC number", () => {
    renderForm()
    change("signup-crc", "sad")
    expect(screen.getByRole("option", { name: "Saddar Branch" })).toBeTruthy()
    expect(screen.queryByRole("option", { name: "Clifton Branch" })).toBeNull()
  })

  it("refuses a malformed CRC instead of adding it", () => {
    renderForm()
    change("signup-crc", "AB 12")
    fireEvent.click(screen.getAllByRole("button", { name: /Add/ })[0])
    expect(screen.getByText("Use letters, numbers and dashes only")).toBeTruthy()
    expect(screen.getByText("No CRCs added yet.")).toBeTruthy()
  })

  it("sends a version 2 body with the domain on every address and no username or role", async () => {
    const onSubmit = renderForm()
    fillValidForm()
    await send()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const payload = onSubmit.mock.calls[0][0]
    expect(payload).toMatchObject({
      formVersion: 2,
      fullName: "Huzaifa Abid",
      email: "huzaifa.abid@ubl.com.pk",
      department: "Finance",
      branches: [{ branchId: 4 }, { crc: "AB-ABC-123" }],
      addresses: ["Plot 1, Clifton, Karachi"],
      approvers: [
        { level: 1, email: "first.approver@ubl.com.pk", designation: "Head of Finance" },
        { level: 2, email: "second.approver@ubl.com.pk", designation: "Manager" },
      ],
      termsAccepted: true,
    })
    expect(payload).not.toHaveProperty("username")
    expect(payload).not.toHaveProperty("role")
  })

  it("does not send a CRC or an address that was unchecked", async () => {
    const onSubmit = renderForm()
    fillValidForm()
    fireEvent.click(screen.getByRole("checkbox", { name: /AB-ABC-123/ }))
    await send()
    expect(onSubmit.mock.calls[0][0].branches).toEqual([{ branchId: 4 }])
  })

  it("does not send while anything required is missing", async () => {
    const onSubmit = renderForm()
    await send()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText("Add at least one CRC and keep it checked")).toBeTruthy()
    expect(screen.getByText("Accept the terms to continue")).toBeTruthy()
  })
})
