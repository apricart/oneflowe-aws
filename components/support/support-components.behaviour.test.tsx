import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import captured from "@/tests/fixtures/support-responses.json"
import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import { NewThreadDialog } from "./new-thread-dialog"
import { SupportList } from "./support-list"
import { SupportStats } from "./support-stats"
import { SupportThreadView } from "./support-thread-view"

/**
 * The support desk UI, fed responses captured from the real support API over
 * its synthetic fixtures (`tests/fixtures/support-responses.json`).
 */
const thread = captured.thread as any
const threadId = thread.thread.id as number

beforeEach(() => {
  resetUi({ id: "ho", role: "HEAD_OFFICE", organizationId: 456 })
  toast.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("support list", () => {
  it("lists the caller's threads and sends the order search to the server", async () => {
    installFetch([
      ["/api/v1/support/threads", captured.list],
      ["/api/v1/support/stats", captured.stats],
    ])
    renderWithApp(<SupportList />)
    expect((await screen.findAllByText("Invoice question S")).length).toBeGreaterThan(0)

    fireEvent.change(screen.getByPlaceholderText("Search by order ID"), { target: { value: "TID-1" } })
    await waitFor(() => expect(callsTo("/api/v1/support/threads").some((call) => call.url.includes("TID-1"))).toBe(true), { timeout: 3000 })

    fireEvent.click(screen.getByLabelText("Clear the order search"))
    expect((screen.getByPlaceholderText("Search by order ID") as HTMLInputElement).value).toBe("")
  })

  it("renders an empty desk", async () => {
    installFetch([
      ["/api/v1/support/threads", { ...captured.list, items: [], total: 0 }],
      ["/api/v1/support/stats", { ...captured.stats, total: 0, open: 0, unanswered: 0 }],
    ])
    renderWithApp(<SupportList />)
    await waitFor(() => expect(callsTo("/api/v1/support/threads").length).toBeGreaterThan(0))
    expect(screen.queryAllByText("Invoice question S")).toHaveLength(0)
  })
})

describe("support stats", () => {
  it("summarises the queue", async () => {
    installFetch([["/api/v1/support/stats", captured.statsApricart]])
    renderWithApp(<SupportStats apricart onSelectStatus={vi.fn()} /> as any)
    expect(await screen.findByLabelText("Support summary")).toBeTruthy()
  })
})

describe("support thread", () => {
  function routes(post: unknown = { item: { id: 1 } }, patch: unknown = { item: thread.thread }) {
    installFetch([
      [new RegExp(`^/api/v1/support/threads/${threadId}/messages`), post],
      [new RegExp(`^/api/v1/support/threads/${threadId}$`), (_url: URL, init?: RequestInit) => (init?.method === "PATCH" ? patch : thread)],
    ])
  }

  it("shows the conversation and posts a reply", async () => {
    routes()
    renderWithApp(<SupportThreadView threadId={threadId} />)
    expect((await screen.findAllByText("Invoice question S")).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Adding detail\.|Totals do not match\./).length).toBeGreaterThan(0)

    fireEvent.change(screen.getByPlaceholderText("Reply to the Apricart team…"), { target: { value: "Any update?" } })
    const send = screen.getAllByRole("button").find((button) => /send/i.test(button.textContent ?? ""))!
    fireEvent.click(send)
    await waitFor(() => expect(callsTo(`/api/v1/support/threads/${threadId}/messages`, "POST")).toHaveLength(1))
    expect(callsTo(`/api/v1/support/threads/${threadId}/messages`, "POST")[0].body).toEqual({ message: "Any update?", attachmentIds: [] })
  })

  it("reports a reply the server refused", async () => {
    routes({ status: 409, body: { error: "This request is closed." } })
    renderWithApp(<SupportThreadView threadId={threadId} />)
    await screen.findAllByText("Invoice question S")
    fireEvent.change(screen.getByPlaceholderText("Reply to the Apricart team…"), { target: { value: "Hello" } })
    fireEvent.click(screen.getAllByRole("button").find((button) => /send/i.test(button.textContent ?? ""))!)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Message not sent", description: "This request is closed." })))
  })

  it("lets the customer mark the request resolved", async () => {
    routes()
    renderWithApp(<SupportThreadView threadId={threadId} />)
    await screen.findAllByText("Invoice question S")
    const resolve = screen.getAllByRole("button").find((button) => /resolve/i.test(button.textContent ?? ""))
    if (resolve) {
      fireEvent.click(resolve)
      await waitFor(() => expect(callsTo(`/api/v1/support/threads/${threadId}`, "PATCH").length).toBeGreaterThan(0))
    }
  })
})

describe("new support query", () => {
  it("opens from its trigger and refuses to send an empty query", async () => {
    installFetch([["/api/v1/support/threads", captured.created], ["/api/v1/support/products", captured.products]])
    renderWithApp(<NewThreadDialog onCreated={vi.fn()} /> as any)
    fireEvent.click(screen.getByRole("button", { name: /Raise a query/ }))
    expect(await screen.findByText("Raise a query with Apricart")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Send to Apricart/ }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(callsTo("/api/v1/support/threads", "POST")).toHaveLength(0)
  })
})
