import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApprovalLevelField, approvalLevelPayload, useApprovalLevelChoice } from "./approval-level-field"

/**
 * The "Approval level" field on Create / Edit User
 * (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md). The server is the
 * control; this pins that the form offers a level exactly where the server
 * would accept one, and lists the organization's own levels.
 */

type LevelsReply = {
  enabled: boolean
  orderApprovalRequired: boolean
  orderApproverRole: string
  levels: { level: number; maxAmountCents: number }[]
}

const LEVELS_ON: LevelsReply = {
  enabled: true,
  orderApprovalRequired: true,
  orderApproverRole: "BRANCH_ADMIN",
  levels: [{ level: 1, maxAmountCents: 6_000_000 }, { level: 2, maxAmountCents: 2_000_000 }],
}

function stubLevels(reply: LevelsReply) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => reply }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function Harness({ organizationId, role, value = "" }: Readonly<{ organizationId: string; role: string; value?: string }>) {
  const choice = useApprovalLevelChoice(organizationId, role)
  return (
    <>
      <span data-testid="applicable">{String(choice.applicable)}</span>
      <ApprovalLevelField id="level" choice={choice} value={value} onChange={() => undefined} />
    </>
  )
}

const renderHarness = (props: Parameters<typeof Harness>[0]) => render(
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    <Harness {...props} />
  </SWRConfig>,
)

describe("ApprovalLevelField", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("offers the organization's levels, highest first with its amount, to its approver role", async () => {
    const fetchMock = stubLevels(LEVELS_ON)
    renderHarness({ organizationId: "7", role: "BRANCH_ADMIN", value: "2" })

    await waitFor(() => expect(screen.getByTestId("applicable").textContent).toBe("true"))
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/organizations/7/approval-levels", expect.anything())
    expect(screen.getByLabelText("Approval level (optional)")).toBeTruthy()
    expect(screen.getByText("Level 2 — orders from PKR 20,000.00")).toBeTruthy()
  })

  it("offers a level to a Group User whatever the configured approver role", async () => {
    stubLevels({ ...LEVELS_ON, orderApproverRole: "HEAD_OFFICE" })
    renderHarness({ organizationId: "7", role: "GROUP_USER" })
    await waitFor(() => expect(screen.getByTestId("applicable").textContent).toBe("true"))
  })

  it.each([
    ["approval is not required", { ...LEVELS_ON, orderApprovalRequired: false }, "BRANCH_ADMIN"],
    ["levels are switched off", { ...LEVELS_ON, enabled: false }, "BRANCH_ADMIN"],
    ["the organization has no levels", { ...LEVELS_ON, levels: [] }, "BRANCH_ADMIN"],
    ["the role is not the configured approver", LEVELS_ON, "HEAD_OFFICE"],
  ])("shows nothing when %s", async (_label, reply, role) => {
    const fetchMock = stubLevels(reply)
    renderHarness({ organizationId: "7", role })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // Give SWR its turn to settle before asserting the field stayed away.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByTestId("applicable").textContent).toBe("false")
    expect(screen.queryByLabelText("Approval level (optional)")).toBeNull()
  })

  it.each([
    ["an ordering role", "7", "ORDER_PORTAL"],
    ["no organization yet", "", "BRANCH_ADMIN"],
  ])("does not even look the levels up for %s", (_label, organizationId, role) => {
    const fetchMock = stubLevels(LEVELS_ON)
    renderHarness({ organizationId, role })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByLabelText("Approval level (optional)")).toBeNull()
  })
})

describe("approvalLevelPayload", () => {
  it("sends null for no level and the number otherwise", () => {
    expect(approvalLevelPayload("")).toBeNull()
    expect(approvalLevelPayload("3")).toBe(3)
  })
})
