import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { jsonFetcher } = vi.hoisted(() => ({ jsonFetcher: vi.fn() }))
vi.mock("@/lib/fetcher", () => ({ jsonFetcher, fetcher: vi.fn() }))

import { DepartmentJoinEditForm } from "./department-join-edit-form"

/**
 * Head Office correcting a pending department sign-up. The endpoint is the
 * control; this pins that every field reaches it as edited, and that a draft
 * the endpoint would refuse is not sent.
 */

const REVIEW = {
  person: {
    firstName: "Sana",
    lastName: "Mir",
    email: "sana.mir@demo.test",
    username: "sana.mir",
    phone: "03001234567",
    employeeId: "E-7",
    department: "Finance",
    ipExtension: "1234",
  },
  branches: [{ kind: "new" as const, branchId: null, name: null, costCenterId: "CRC-9" }],
  addresses: [{ requestAddressId: 41, address: "Plot 4, Clifton" }],
  approvers: [{ level: 1, email: "one@demo.test", designation: "Director" }],
}

function renderForm() {
  const onSaved = vi.fn()
  render(
    <DepartmentJoinEditForm
      requestId={9}
      review={REVIEW}
      emailDomain="demo.test"
      organizationBranches={[{ id: 5, name: "Clifton" }]}
      onSaved={onSaved}
      onCancel={vi.fn()}
    />,
  )
  return onSaved
}

const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("DepartmentJoinEditForm", () => {
  it("sends every edited field and reports the save", async () => {
    jsonFetcher.mockResolvedValue({ id: 9, updated: true })
    const onSaved = renderForm()

    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: "03111111111" } })
    fireEvent.change(screen.getByLabelText(/^Department/), { target: { value: "IT" } })
    fireEvent.change(screen.getByLabelText(/^Level 1 email/), { target: { value: "boss@demo.test" } })
    fireEvent.change(screen.getByLabelText("Add an existing branch"), { target: { value: "5" } })
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0])
    fireEvent.click(screen.getByRole("button", { name: "Remove New branch for CRC CRC-9" }))
    fireEvent.change(screen.getByLabelText("Delivery address 1"), { target: { value: "Plot 5, Clifton" } })
    save()

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [url, init] = jsonFetcher.mock.calls[0]
    expect(url).toBe("/api/v1/join-requests/9")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body)).toEqual({
      update: {
        firstName: "Sana",
        lastName: "Mir",
        email: "sana.mir@demo.test",
        username: "sana.mir",
        phone: "03111111111",
        ipExtension: "1234",
        employeeId: "E-7",
        department: "IT",
        branches: [{ branchId: 5 }],
        addresses: ["Plot 5, Clifton"],
        approvers: [{ level: 1, email: "boss@demo.test", designation: "Director" }],
      },
    })
  })

  it("names the problem and sends nothing when an email is off the domain", () => {
    renderForm()
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "sana@elsewhere.test" } })
    save()

    expect(screen.getByRole("alert").textContent).toBe("Correct the highlighted fields before saving.")
    expect(screen.getByText("Use an @demo.test email address")).toBeTruthy()
    expect(jsonFetcher).not.toHaveBeenCalled()
  })

  it("shows the server's refusal and stays open", async () => {
    jsonFetcher.mockRejectedValue(new Error("The username sana.mir is already in use. Choose another."))
    const onSaved = renderForm()
    save()

    expect((await screen.findByRole("alert")).textContent).toBe("The username sana.mir is already in use. Choose another.")
    expect(onSaved).not.toHaveBeenCalled()
  })
})
