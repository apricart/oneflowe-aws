import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ActivityLogScreen, activityQueryFor } from "@/components/activity/activity-log-screen"
import { EMPTY_FILTERS, activeFilterChips } from "@/components/activity/activity-log-filters"
import { ACTIVITY_PAGE_SIZE_DEFAULT, type ActivityEvent, type ActivityLogPage } from "@/lib/activity-log"

/**
 * The screen's three states, its filters, and its paging — with the endpoint
 * replaced by a recording `fetch`.
 *
 * What is worth testing here is the contract between the screen and the route:
 * that a filter becomes the query parameter the route validates, that the second
 * page is *appended* rather than replacing the first, and that an error shows the
 * server's message rather than a raw exception. The route's own behaviour is
 * `tests/integration/activity-log-api.test.ts`.
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

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "audit:1",
    source: "audit",
    occurredAt: "2026-09-26T10:00:00.000Z",
    action: "DELETE_CATEGORY",
    actionLabel: "Delete category",
    operation: "delete",
    category: "catalogue",
    severity: "critical",
    entity: "category",
    entityLabel: "Category",
    entityId: "42",
    actor: { id: "u-1", email: "ali@example.test", name: "Ali Raza", role: "SUPER_ADMIN" },
    organizationId: 3,
    organizationName: "Apricart",
    branchId: 9,
    branchName: "North",
    success: true,
    errorMessage: null,
    ipAddress: "198.51.100.7",
    userAgent: "Mozilla/5.0",
    metadata: { before: { name: "Retired" }, ip: "198.51.100.7" },
    ...overrides,
  }
}

function page(overrides: Partial<ActivityLogPage> = {}): ActivityLogPage {
  return {
    items: [event()],
    nextCursor: null,
    hasMore: false,
    window: { from: "2026-09-19T12:00:00.000Z", to: "2026-09-26T12:00:00.000Z" },
    ...overrides,
  }
}

/** Replaces `fetch`, recording every URL it was called with. */
function stubFetch(responses: { ok?: boolean; status?: number; body: unknown }[]) {
  const urls: string[] = []
  let call = 0
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(String(url))
    const response = responses[Math.min(call, responses.length - 1)]
    call += 1
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
    } as Response
  })
  vi.stubGlobal("fetch", fetchMock)
  return { urls, fetchMock }
}

describe("the query the screen builds", () => {
  const now = new Date("2026-09-26T12:00:00.000Z")

  it("bounds the first read and asks for one page", () => {
    const query = activityQueryFor(EMPTY_FILTERS, now)
    const params = new URLSearchParams(query.split("?")[1])
    expect(query.startsWith("/api/v1/activity-logs?")).toBe(true)
    expect(params.get("limit")).toBe(String(ACTIVITY_PAGE_SIZE_DEFAULT))
    expect(params.get("from")).toBe("2026-09-19T12:00:00.000Z")
    expect(params.get("to")).toBe(now.toISOString())
  })

  it("sends only the filters that are set", () => {
    const params = new URLSearchParams(activityQueryFor(EMPTY_FILTERS, now).split("?")[1])
    for (const key of ["source", "operation", "category", "outcome", "search", "cursor"]) {
      expect(params.has(key)).toBe(false)
    }
  })

  it("names each filter the way the route validates it", () => {
    const params = new URLSearchParams(
      activityQueryFor(
        {
          ...EMPTY_FILTERS,
          source: "group",
          operation: "delete",
          category: "pricing",
          outcome: "failure",
          search: "  ali  ",
        },
        now,
      ).split("?")[1],
    )
    expect(params.get("source")).toBe("group")
    expect(params.get("operation")).toBe("delete")
    expect(params.get("category")).toBe("pricing")
    expect(params.get("outcome")).toBe("failure")
    // Trimmed, so a stray space is not part of the term.
    expect(params.get("search")).toBe("ali")
  })

  it("sends a custom range as the whole of both days", () => {
    const params = new URLSearchParams(
      activityQueryFor(
        { ...EMPTY_FILTERS, preset: "custom", customFrom: "2026-09-01", customTo: "2026-09-02" },
        now,
      ).split("?")[1],
    )
    // Local midnight to local end-of-day: a reader picking one day means that
    // whole day where they are, not a UTC window that clips it.
    expect(new Date(params.get("from")!).getHours()).toBe(0)
    expect(new Date(params.get("to")!).getHours()).toBe(23)
  })
})

describe("activeFilterChips", () => {
  it("shows nothing when nothing is filtered", () => {
    expect(activeFilterChips(EMPTY_FILTERS)).toEqual([])
  })

  it("names every active filter, so one left on by accident is visible", () => {
    const chips = activeFilterChips({
      ...EMPTY_FILTERS,
      source: "audit",
      operation: "delete",
      category: "pricing",
      outcome: "failure",
      search: "ali",
    })
    expect(chips.map((chip) => chip.key)).toEqual([
      "source",
      "operation",
      "category",
      "outcome",
      "search",
    ])
    expect(chips.find((chip) => chip.key === "operation")?.label).toContain("Deleted")
  })

  it("ignores a blank search", () => {
    expect(activeFilterChips({ ...EMPTY_FILTERS, search: "   " })).toEqual([])
  })
})

describe("the three states", () => {
  it("shows a loading state before the first page arrives", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    render(<ActivityLogScreen />)
    expect(screen.getByLabelText("Loading activity")).toBeTruthy()
  })

  it("shows the rows once they arrive", async () => {
    stubFetch([{ body: page() }])
    render(<ActivityLogScreen />)

    await waitFor(() => expect(screen.getByText("Delete category")).toBeTruthy())
    expect(screen.getByText("1 event loaded")).toBeTruthy()
    expect(screen.getByText("Ali Raza")).toBeTruthy()
    expect(screen.getByText("Apricart · North")).toBeTruthy()
    // Severity and operation are named, never carried by colour alone.
    expect(screen.getByText("Critical")).toBeTruthy()
    expect(screen.getByText("Deleted")).toBeTruthy()
  })

  it("shows an empty state that says coverage is not yet complete", async () => {
    stubFetch([{ body: page({ items: [] }) }])
    render(<ActivityLogScreen />)

    await waitFor(() => expect(screen.getByText("No activity in this period")).toBeTruthy())
    expect(screen.getByText(/not every operation/i)).toBeTruthy()
  })

  it("shows the server's message on an error, not a raw exception", async () => {
    stubFetch([{ ok: false, status: 400, body: { error: "The date range may not exceed 366 days" } }])
    render(<ActivityLogScreen />)

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(screen.getByText("The date range may not exceed 366 days")).toBeTruthy()
  })

  it("offers a retry that asks again", async () => {
    const { fetchMock } = stubFetch([
      { ok: false, status: 500, body: { error: "Something went wrong" } },
      { body: page() },
    ])
    render(<ActivityLogScreen />)

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))

    await waitFor(() => expect(screen.getByText("Delete category")).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("paging", () => {
  it("offers Load more only while there is a next cursor", async () => {
    stubFetch([{ body: page({ nextCursor: null }) }])
    render(<ActivityLogScreen />)

    await waitFor(() => expect(screen.getByText("Delete category")).toBeTruthy())
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull()
  })

  it("appends the next page rather than replacing the first", async () => {
    const { urls } = stubFetch([
      { body: page({ items: [event({ id: "audit:1" })], nextCursor: "CURSOR_1", hasMore: true }) },
      {
        body: page({
          items: [event({ id: "audit:2", actionLabel: "Create category", action: "CREATE_CATEGORY" })],
          nextCursor: null,
        }),
      },
    ])
    render(<ActivityLogScreen />)

    await waitFor(() => expect(screen.getByText("1 event loaded (more available)")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /load more/i }))

    await waitFor(() => expect(screen.getByText("2 events loaded")).toBeTruthy())
    // Both pages are on screen at once.
    expect(screen.getByText("Delete category")).toBeTruthy()
    expect(screen.getByText("Create category")).toBeTruthy()
    // The second request carried the cursor the first returned.
    expect(new URLSearchParams(urls[1].split("?")[1]).get("cursor")).toBe("CURSOR_1")
  })

  it("never sends a cursor on the first read of a list", async () => {
    const { urls } = stubFetch([{ body: page() }])
    render(<ActivityLogScreen />)
    await waitFor(() => expect(screen.getByText("Delete category")).toBeTruthy())
    expect(new URLSearchParams(urls[0].split("?")[1]).has("cursor")).toBe(false)
  })
})

describe("the detail panel", () => {
  it("opens from a row and shows who, from where, and what changed", async () => {
    stubFetch([{ body: page() }])
    render(<ActivityLogScreen />)

    await waitFor(() => expect(screen.getByText("Delete category")).toBeTruthy())

    // The row is a button, so it is reachable and operable from the keyboard.
    const row = screen.getByRole("button", { name: /Delete category, Deleted, Critical/ })
    fireEvent.click(row)

    const panel = await waitFor(() => screen.getByRole("dialog"))
    expect(within(panel).getByText("DELETE_CATEGORY")).toBeTruthy()
    expect(within(panel).getByText("198.51.100.7")).toBeTruthy()
    expect(within(panel).getByText("What changed")).toBeTruthy()
    expect(within(panel).getByText("name")).toBeTruthy()
    expect(within(panel).getByText("Retired")).toBeTruthy()
    expect(within(panel).getByText("audit:1")).toBeTruthy()
  })

  it("names the whole row for a screen reader", async () => {
    stubFetch([{ body: page({ items: [event({ success: false, errorMessage: "invalid_password" })] }) }])
    render(<ActivityLogScreen />)

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /failed \(invalid_password\)/ })).toBeTruthy(),
    )
  })
})

describe("export", () => {
  it("is disabled until there is something to export", async () => {
    stubFetch([{ body: page({ items: [] }) }])
    render(<ActivityLogScreen />)

    await waitFor(() => expect(screen.getByText("No activity in this period")).toBeTruthy())
    expect(screen.getByRole("button", { name: /export csv/i }).getAttribute("disabled")).not.toBeNull()
  })

  it("exports what is loaded without asking the server again", async () => {
    const { fetchMock } = stubFetch([{ body: page() }])
    const createObjectURL = vi.fn(() => "blob:activity")
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    render(<ActivityLogScreen />)
    await waitFor(() => expect(screen.getByText("Delete category")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }))

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    // No second endpoint means no second unbounded read path.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
