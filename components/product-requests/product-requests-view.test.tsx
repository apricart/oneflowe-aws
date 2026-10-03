import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import ProductRequestsView from "@/components/product-requests/product-requests-view"
import type { ProductRequestList, ProductRequestListItem } from "@/lib/product-request"

/**
 * What each role is offered on the Product Requests screen, and the review
 * round trip, with the endpoints replaced by a recording `fetch`.
 *
 * The controls shown here are presentation — the handlers are the control, and
 * `tests/integration/product-requests-api.test.ts` proves they refuse the same
 * things. This file proves the screen does not offer them in the first place.
 */

// 3 Oct 2026, 10:00 in Karachi. Only `Date` is faked, so SWR's timers still run.
const NOW = new Date("2026-10-03T05:00:00.000Z")

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.setPointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function item(overrides: Partial<ProductRequestListItem> = {}): ProductRequestListItem {
  return {
    id: 11,
    status: "PENDING",
    productName: "Hand sanitiser",
    brand: "Dettol",
    description: "Alcohol based gel",
    category: { id: 1, name: "Cleaning" },
    subcategory: { id: 2, name: "Hand care" },
    unit: "bottle",
    packSize: "500 ml",
    barcode: null,
    expectedPriceCents: 45_000,
    estimatedMonthlyQuantity: 120,
    preferredSupplier: "Reckitt",
    referenceUrl: "https://example.com/sanitiser",
    notes: "Every branch asks for it",
    imageUrl: null,
    reviewStartedAt: null,
    reviewStartedBy: null,
    reviewNote: null,
    reviewedAt: null,
    reviewedBy: null,
    estimatedAvailableOn: null,
    createdAt: "2026-09-30T09:00:00.000Z",
    organization: { id: 10, name: "K-Electric" },
    requestedBy: { id: "u-ho", fullName: "Sara Head Office", email: "sara@example.test", role: "HEAD_OFFICE" },
    ...overrides,
  }
}

function list(items: ProductRequestListItem[], overrides: Partial<ProductRequestList> = {}): ProductRequestList {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    counts: {
      PENDING: items.filter((entry) => entry.status === "PENDING").length,
      UNDER_REVIEW: items.filter((entry) => entry.status === "UNDER_REVIEW").length,
      APPROVED: 0,
      REJECTED: 0,
    },
    organizations: [],
    ...overrides,
  }
}

type Call = { url: string; method: string; body: unknown }
type Reply = { status: number; body: unknown }

function json(reply: Reply): Response {
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } })
}

/** GETs of the list answer `listReply`; a PATCH answers `patchReply`. */
function stubFetch(listReply: Reply, patchReply: Reply = { status: 200, body: {} }) {
  const calls: Call[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (method === "PATCH") return json(patchReply)
    if (String(url).startsWith("/api/v1/product-requests")) return json(listReply)
    return json({ status: 200, body: { items: [] } })
  }))
  return calls
}

function renderView(role: string) {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductRequestsView role={role} />
    </SWRConfig>,
  )
}

describe("ProductRequestsView for Head Office", () => {
  it("offers the request form and lists its organization's requests without an organization column", async () => {
    stubFetch({ status: 200, body: list([item()]) })
    renderView("HEAD_OFFICE")

    expect(screen.getByRole("button", { name: "Request a product" })).toBeTruthy()
    expect(await screen.findByText("Hand sanitiser")).toBeTruthy()
    expect(screen.getByText("sara@example.test")).toBeTruthy()
    expect(screen.queryByRole("columnheader", { name: "Organization" })).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Filter by organization" })).toBeNull()
  })

  it("opens a pending request read-only — no decision buttons", async () => {
    stubFetch({ status: 200, body: list([item()]) })
    renderView("HEAD_OFFICE")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Reckitt")).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /Approve/ })).toBeNull()
    expect(within(dialog).queryByRole("button", { name: /Reject/ })).toBeNull()
  })

  it("shows the outcome and Super Admin's note on a decided request", async () => {
    stubFetch({
      status: 200,
      body: list([item({
        status: "REJECTED",
        reviewNote: "Already stocked as Floor Clean",
        reviewedAt: "2026-09-30T12:00:00.000Z",
        reviewedBy: { id: "u-sa", fullName: "Apricart Admin" },
      })]),
    })
    renderView("HEAD_OFFICE")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Already stocked as Floor Clean")).toBeTruthy()
    expect(within(dialog).getByText("Rejected by")).toBeTruthy()
  })

  it("shows a request Super Admin is working on as under review, with who and since when", async () => {
    stubFetch({
      status: 200,
      body: list([item({
        status: "UNDER_REVIEW",
        reviewStartedAt: "2026-10-01T06:00:00.000Z",
        reviewStartedBy: { id: "u-sa", fullName: "Apricart Admin" },
      })]),
    })
    renderView("HEAD_OFFICE")

    const row = await screen.findByRole("row", { name: "Open request for Hand sanitiser" })
    expect(within(row).getByText("Under review")).toBeTruthy()
    fireEvent.click(row)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Apricart Admin is reviewing this request. The decision will appear here.")).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /Approve|Reject|Mark under review/ })).toBeNull()
  })

  it("shows when an approved product is expected in the catalogue, in the list and the request", async () => {
    stubFetch({
      status: 200,
      body: list([item({
        status: "APPROVED",
        reviewedAt: "2026-10-02T12:00:00.000Z",
        reviewedBy: { id: "u-sa", fullName: "Apricart Admin" },
        estimatedAvailableOn: "2026-10-15",
      })]),
    })
    renderView("HEAD_OFFICE")

    const row = await screen.findByRole("row", { name: "Open request for Hand sanitiser" })
    expect(within(row).getByText("Expected by 15 Oct 2026")).toBeTruthy()
    fireEvent.click(row)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/Expected in the catalogue by/).textContent).toBe("Expected in the catalogue by 15 Oct 2026")
  })

  it("says so when an approval made before dates existed has none", async () => {
    stubFetch({
      status: 200,
      body: list([item({ status: "APPROVED", reviewedAt: "2026-09-30T12:00:00.000Z", reviewedBy: { id: "u-sa", fullName: "A" } })]),
    })
    renderView("HEAD_OFFICE")

    const row = await screen.findByRole("row", { name: "Open request for Hand sanitiser" })
    expect(within(row).queryByText(/Expected by/)).toBeNull()
    fireEvent.click(row)
    expect(within(await screen.findByRole("dialog")).getByText("No availability date was given.")).toBeTruthy()
  })

  it("opens every tab on all statuses", async () => {
    const calls = stubFetch({ status: 200, body: list([]) })
    renderView("HEAD_OFFICE")
    await screen.findByText("No product requests")
    const params = new URL(`http://x${calls[0].url}`).searchParams
    expect(params.get("status")).toBeNull()
  })
})

describe("ProductRequestsView for Super Admin", () => {
  it("does not offer the request form, shows who asked and from which organization, and starts on pending", async () => {
    const calls = stubFetch({
      status: 200,
      body: list([item()], { organizations: [{ id: 10, name: "K-Electric" }] }),
    })
    renderView("SUPER_ADMIN")

    expect(await screen.findByText("Hand sanitiser")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Request a product" })).toBeNull()
    expect(screen.getByRole("columnheader", { name: "Organization" })).toBeTruthy()
    expect(screen.getByText("Sara Head Office")).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Filter by organization" })).toBeTruthy()
    expect(new URL(`http://x${calls[0].url}`).searchParams.get("status")).toBe("PENDING")
  })

  it("approves a pending request with its note and date and refreshes the list", async () => {
    const calls = stubFetch({ status: 200, body: list([item()]) }, { status: 200, body: { id: 11, status: "APPROVED" } })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Note to Head Office (optional)"), { target: { value: "Added as KE-9001" } })
    fireEvent.change(within(dialog).getByLabelText("Expected in catalogue by"), { target: { value: "2026-10-15" } })
    fireEvent.click(within(dialog).getByRole("button", { name: /Approve/ }))

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true))
    const patch = calls.find((call) => call.method === "PATCH")!
    expect(patch.url).toBe("/api/v1/product-requests/11")
    expect(patch.body).toEqual({ status: "APPROVED", reviewNote: "Added as KE-9001", estimatedAvailableOn: "2026-10-15" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(calls.filter((call) => call.method === "GET" && call.url.startsWith("/api/v1/product-requests")).length).toBeGreaterThan(1)
  })

  it("does not send an approval without a date, and says why beside the field", async () => {
    const calls = stubFetch({ status: 200, body: list([item()]) })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: /Approve/ }))

    const field = within(dialog).getByLabelText("Expected in catalogue by")
    expect(field.getAttribute("aria-invalid")).toBe("true")
    expect(within(dialog).getByText("Choose the date the product is expected in the catalogue").id)
      .toBe(field.getAttribute("aria-describedby"))
    expect(calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  it("does not send a date that has already passed", async () => {
    const calls = stubFetch({ status: 200, body: list([item()]) })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Expected in catalogue by"), { target: { value: "2026-10-02" } })
    fireEvent.click(within(dialog).getByRole("button", { name: /Approve/ }))

    expect(within(dialog).getByText("Expected availability date cannot be in the past")).toBeTruthy()
    expect(calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  it("fills the date from a quick pick counted from today, and bounds the picker", async () => {
    const calls = stubFetch({ status: 200, body: list([item()]) }, { status: 200, body: { id: 11, status: "APPROVED" } })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    const field = within(dialog).getByLabelText("Expected in catalogue by") as HTMLInputElement
    expect(field.min).toBe("2026-10-03")
    expect(field.max).toBe("2027-10-03")
    fireEvent.click(within(dialog).getByRole("button", { name: "In 2 weeks" }))
    expect(field.value).toBe("2026-10-17")
    fireEvent.click(within(dialog).getByRole("button", { name: /Approve/ }))

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true))
    expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({ estimatedAvailableOn: "2026-10-17" })
  })

  it("marks a pending request under review with nothing but the status", async () => {
    const calls = stubFetch({ status: 200, body: list([item()]) }, { status: 200, body: { id: 11, status: "UNDER_REVIEW" } })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Note to Head Office (optional)"), { target: { value: "ignored" } })
    fireEvent.click(within(dialog).getByRole("button", { name: /Mark under review/ }))

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true))
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ status: "UNDER_REVIEW" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("still lets a request under review be approved or rejected, but not put under review again", async () => {
    stubFetch({
      status: 200,
      body: list([item({ status: "UNDER_REVIEW", reviewStartedAt: "2026-10-01T06:00:00.000Z", reviewStartedBy: { id: "u-sa", fullName: "A" } })]),
    })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("button", { name: /Approve/ })).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: /Reject/ })).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /Mark under review/ })).toBeNull()
  })

  it("shows the server's answer when the request was already decided elsewhere", async () => {
    stubFetch({ status: 200, body: list([item()]) }, { status: 409, body: { error: "This request has already been approved" } })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: /Reject/ }))

    expect((await within(dialog).findByRole("alert")).textContent).toBe("This request has already been approved")
  })

  it("renders a reference link only as a web address", async () => {
    stubFetch({ status: 200, body: list([item({ referenceUrl: "javascript:alert(1)" })]) })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByRole("link")).toBeNull()
  })

  it("links a genuine reference in a new tab without handing it the opener", async () => {
    stubFetch({ status: 200, body: list([item()]) })
    renderView("SUPER_ADMIN")

    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const link = within(await screen.findByRole("dialog")).getByRole("link")
    expect(link.getAttribute("href")).toBe("https://example.com/sanitiser")
    expect(link.getAttribute("rel")).toContain("noopener")
  })
})

describe("ProductRequestsView states", () => {
  it("shows the server's message when the list cannot load", async () => {
    stubFetch({ status: 403, body: { error: "Organization context required" } })
    renderView("HEAD_OFFICE")
    expect((await screen.findByRole("alert")).textContent).toContain("Organization context required")
  })

  it("says so when there is nothing to show", async () => {
    stubFetch({ status: 200, body: list([]) })
    renderView("SUPER_ADMIN")
    expect(await screen.findByText("No product requests")).toBeTruthy()
  })
})

describe("ProductRequestDetailDialog layout", () => {
  async function open(overrides: Partial<ProductRequestListItem> = {}, role = "SUPER_ADMIN") {
    stubFetch({ status: 200, body: list([item(overrides)]) })
    renderView(role)
    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    return screen.findByRole("dialog")
  }

  it("leads with the figures a decision turns on, including price × quantity", async () => {
    const dialog = await open()
    // Rs 450.00 × 120 = Rs 54,000.00
    expect(within(dialog).getByText("Estimated monthly value")).toBeTruthy()
    expect(within(dialog).getByText(/≈\s*Rs\s*54,000/)).toBeTruthy()
    expect(within(dialog).getByText("bottle per month")).toBeTruthy()
  })

  it("shows no estimated value when either half is missing", async () => {
    const dialog = await open({ estimatedMonthlyQuantity: null })
    expect(within(dialog).queryByText(/≈/)).toBeNull()
  })

  it("names the empty details once instead of a dash beside each", async () => {
    const dialog = await open()
    expect(within(dialog).getByText(/Barcode \/ manufacturer code/).closest("p")?.textContent)
      .toMatch(/^Not provided: Barcode \/ manufacturer code, Image$/)
  })

  const currentStep = (dialog: HTMLElement) =>
    within(dialog).getByRole("list", { name: "Request progress" }).querySelector("[aria-current='step']")?.textContent

  it("marks a pending request as submitted and waiting", async () => {
    const dialog = await open()
    expect(currentStep(dialog)).toContain("Submitted")
    expect(within(dialog).getByText("Waiting for Super Admin")).toBeTruthy()
  })

  it("marks a request under review at that step, with when it started", async () => {
    const dialog = await open({
      status: "UNDER_REVIEW",
      reviewStartedAt: "2026-10-01T06:00:00.000Z",
      reviewStartedBy: { id: "u-sa", fullName: "A" },
    })
    expect(currentStep(dialog)).toMatch(/^Under reviewSince /)
  })

  it("marks a request decided without a review start as decided directly", async () => {
    const dialog = await open({
      status: "REJECTED",
      reviewedAt: "2026-10-02T06:00:00.000Z",
      reviewedBy: { id: "u-sa", fullName: "A" },
    })
    expect(currentStep(dialog)).toContain("Rejected")
    expect(within(dialog).getByText("Decided directly")).toBeTruthy()
  })

  it("fills the note from a template, still editable, and sends it with the decision", async () => {
    const calls = stubFetch({ status: 200, body: list([item()]) }, { status: 200, body: { id: 11 } })
    renderView("SUPER_ADMIN")
    fireEvent.click(await screen.findByRole("row", { name: "Open request for Hand sanitiser" }))
    const dialog = await screen.findByRole("dialog")

    fireEvent.click(within(dialog).getByRole("button", { name: "Already available in the catalogue." }))
    const note = within(dialog).getByLabelText("Note to Head Office (optional)") as HTMLTextAreaElement
    expect(note.value).toBe("Already available in the catalogue.")
    fireEvent.change(note, { target: { value: "Already available as KE-12." } })
    fireEvent.click(within(dialog).getByRole("button", { name: /Reject/ }))

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true))
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ status: "REJECTED", reviewNote: "Already available as KE-12." })
  })

  it("does not offer the decision to Head Office", async () => {
    const dialog = await open({}, "HEAD_OFFICE")
    expect(within(dialog).queryByRole("group", { name: "Note templates" })).toBeNull()
    expect(within(dialog).queryByLabelText("Note to Head Office (optional)")).toBeNull()
  })
})
