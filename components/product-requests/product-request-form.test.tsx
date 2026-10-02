import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ProductRequestForm } from "@/components/product-requests/product-request-form"

/**
 * The form's contract with `POST /api/v1/product-requests`: what it refuses to
 * send, what it sends, and how it reports the server's answer. The route's own
 * behaviour is `tests/integration/product-requests-api.test.ts`.
 */

// Radix Select needs layout APIs jsdom does not implement.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.setPointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type Call = { url: string; method: string; body: unknown }

/** Categories load empty; the create call answers with `create`. */
function stubFetch(create: { status: number; body: unknown } | (() => Promise<Response>)) {
  const calls: Call[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (method === "POST") {
      if (typeof create === "function") return create()
      return new Response(JSON.stringify(create.body), { status: create.status, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } })
  }))
  return calls
}

function renderForm() {
  const onSubmitted = vi.fn()
  const onCancel = vi.fn()
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductRequestForm onSubmitted={onSubmitted} onCancel={onCancel} />
    </SWRConfig>,
  )
  return { onSubmitted, onCancel }
}

const posts = (calls: Call[]) => calls.filter((call) => call.method === "POST")

describe("ProductRequestForm", () => {
  it("marks no field as required", () => {
    stubFetch({ status: 201, body: { id: 1 } })
    renderForm()
    expect(screen.getByText(/Every field is optional/)).toBeTruthy()
    for (const input of screen.getAllByRole("textbox")) {
      expect((input as HTMLInputElement).required).toBe(false)
    }
  })

  it("refuses to send an empty form and says why, without calling the server", async () => {
    const calls = stubFetch({ status: 201, body: { id: 1 } })
    const { onSubmitted } = renderForm()

    fireEvent.click(screen.getByRole("button", { name: "Send request" }))

    expect((await screen.findByRole("alert")).textContent).toBe("Fill in at least one field — the product name is the most useful")
    expect(posts(calls)).toHaveLength(0)
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it("flags a malformed price on its own field", async () => {
    const calls = stubFetch({ status: 201, body: { id: 1 } })
    renderForm()

    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Soap" } })
    fireEvent.change(screen.getByLabelText("Expected price per unit (PKR)"), { target: { value: "four hundred" } })
    fireEvent.click(screen.getByRole("button", { name: "Send request" }))

    expect((await screen.findByRole("alert")).textContent).toMatch(/Enter the expected price as an amount/)
    expect(screen.getByLabelText("Expected price per unit (PKR)").getAttribute("aria-invalid")).toBe("true")
    expect(posts(calls)).toHaveLength(0)
  })

  it("sends what was typed, with the price as integer cents, and reports success", async () => {
    const calls = stubFetch({ status: 201, body: { id: 7 } })
    const { onSubmitted } = renderForm()

    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: " Hand sanitiser " } })
    fireEvent.change(screen.getByLabelText("Brand / manufacturer"), { target: { value: "Dettol" } })
    fireEvent.change(screen.getByLabelText("Expected price per unit (PKR)"), { target: { value: "450.50" } })
    fireEvent.change(screen.getByLabelText("Estimated monthly quantity"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "Send request" }))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1))
    const [post] = posts(calls)
    expect(post.url).toBe("/api/v1/product-requests")
    expect(post.body).toMatchObject({
      productName: "Hand sanitiser",
      brand: "Dettol",
      expectedPriceCents: 45_050,
      estimatedMonthlyQuantity: 120,
      imageUrl: null,
    })
    // The body carries no tenant or author: those come from the session.
    expect(Object.keys(post.body as object)).not.toContain("organizationId")
  })

  it("shows the server's refusal and keeps what was typed", async () => {
    stubFetch({ status: 400, body: { error: "The selected category does not exist" } })
    const { onSubmitted } = renderForm()

    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Soap" } })
    fireEvent.click(screen.getByRole("button", { name: "Send request" }))

    expect((await screen.findByRole("alert")).textContent).toBe("The selected category does not exist")
    expect((screen.getByLabelText("Product name") as HTMLInputElement).value).toBe("Soap")
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it("sends once however often the button is pressed while a request is in flight", async () => {
    let release: (response: Response) => void = () => undefined
    const calls = stubFetch(() => new Promise<Response>((resolve) => { release = resolve }))
    const { onSubmitted } = renderForm()

    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Soap" } })
    const send = screen.getByRole("button", { name: "Send request" })
    fireEvent.click(send)
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(send)
    fireEvent.click(send)

    release(new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { "content-type": "application/json" } }))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1))
    expect(posts(calls)).toHaveLength(1)
  })

  it("cancels without sending", () => {
    const calls = stubFetch({ status: 201, body: { id: 1 } })
    const { onCancel } = renderForm()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
    expect(posts(calls)).toHaveLength(0)
  })
})

describe("ProductRequestForm guidance", () => {
  it("groups the fields under the question each one answers", () => {
    stubFetch({ status: 201, body: { id: 1 } })
    renderForm()
    for (const title of ["What is the product?", "Size & quantity", "Where to source it", "Why is it needed?", "Photo"]) {
      expect(screen.getByRole("region", { name: title })).toBeTruthy()
    }
  })

  it("fills the unit from a one-click choice, shows it beside the monthly quantity, and clears it again", () => {
    stubFetch({ status: 201, body: { id: 1 } })
    renderForm()

    const box = screen.getByRole("button", { name: "box" })
    fireEvent.click(box)
    expect((screen.getByLabelText("Unit of measure") as HTMLInputElement).value).toBe("box")
    expect(box.getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByText("box / month")).toBeTruthy()

    fireEvent.click(box)
    expect((screen.getByLabelText("Unit of measure") as HTMLInputElement).value).toBe("")
  })

  it("says how many details have been given", () => {
    stubFetch({ status: 201, body: { id: 1 } })
    renderForm()
    expect(screen.getByText("Add at least one detail")).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Soap" } })
    fireEvent.change(screen.getByLabelText("Brand / manufacturer"), { target: { value: "Lux" } })
    expect(screen.getByText("2 of 14 details added")).toBeTruthy()
    expect(screen.getByRole("progressbar", { name: "Details added" }).getAttribute("aria-valuenow")).toBe("2")
  })

  it("takes the person to the field that needs fixing", async () => {
    stubFetch({ status: 201, body: { id: 1 } })
    renderForm()
    fireEvent.change(screen.getByLabelText("Expected price per unit (PKR)"), { target: { value: "lots" } })
    fireEvent.click(screen.getByRole("button", { name: "Send request" }))

    await screen.findByRole("alert")
    expect(document.activeElement).toBe(screen.getByLabelText("Expected price per unit (PKR)"))
  })

  it("counts the characters of a long answer against its limit", () => {
    stubFetch({ status: 201, body: { id: 1 } })
    renderForm()
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "abc" } })
    expect(screen.getByText("3/1000")).toBeTruthy()
  })
})
