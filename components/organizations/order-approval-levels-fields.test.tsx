import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MAX_APPROVAL_LEVELS } from "@/lib/order-approval-levels"

import { OrderApprovalLevelsFields } from "./order-approval-levels-fields"

/** The section as a dialog holds it: its own state, reported upwards. */
function Harness({
  initialEnabled = false,
  initialLevels = [],
  disabled = false,
  onChange = () => undefined,
}: Readonly<{
  initialEnabled?: boolean
  initialLevels?: string[]
  disabled?: boolean
  onChange?: (state: { enabled: boolean; levels: string[] }) => void
}>) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [levels, setLevels] = useState(initialLevels)
  return (
    <OrderApprovalLevelsFields
      idPrefix="test"
      enabled={enabled}
      levels={levels}
      disabled={disabled}
      onEnabledChange={(next) => {
        setEnabled(next)
        onChange({ enabled: next, levels })
      }}
      onLevelsChange={(next) => {
        setLevels(next)
        onChange({ enabled, levels: next })
      }}
    />
  )
}

const levelInput = (level: number) => screen.getByLabelText(`Level ${level} approver`) as HTMLInputElement
const addButton = () => screen.getByRole("button", { name: /add approver level/i }) as HTMLButtonElement
const toggle = () => screen.getByRole("switch", { name: "Order approval levels" }) as HTMLButtonElement
const isOn = (element: HTMLElement) => element.getAttribute("aria-checked") === "true"

describe("OrderApprovalLevelsFields", () => {
  afterEach(() => {
    cleanup()
  })

  it("shows nothing but the switch while the feature is off", () => {
    render(<Harness />)

    expect(isOn(toggle())).toBe(false)
    expect(screen.queryByLabelText("Level 1 approver")).toBeNull()
    expect(screen.queryByRole("button", { name: /add approver level/i })).toBeNull()
  })

  it("shows Level 1 with an amount field as soon as it is switched on", () => {
    render(<Harness />)

    fireEvent.click(toggle())

    expect(levelInput(1).value).toBe("")
    expect(screen.queryByLabelText("Level 2 approver")).toBeNull()
    // A fresh, empty Level 1 is not shouted at; Save is what stays disabled.
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("adds Level 2, Level 3 and so on, each with its own amount", () => {
    render(<Harness initialEnabled initialLevels={["40000"]} />)

    fireEvent.click(addButton())
    fireEvent.change(levelInput(2), { target: { value: "80000" } })
    fireEvent.click(addButton())

    expect(levelInput(1).value).toBe("40000")
    expect(levelInput(2).value).toBe("80000")
    expect(levelInput(3).value).toBe("")
  })

  it("offers Remove on the last level only, and never on a lone Level 1", () => {
    render(<Harness initialEnabled initialLevels={["40000", "80000", "120000"]} />)

    expect(screen.queryByRole("button", { name: "Remove level 1" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Remove level 2" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Remove level 3" }))

    expect(screen.queryByLabelText("Level 3 approver")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Remove level 2" }))
    expect(screen.queryByLabelText("Level 2 approver")).toBeNull()
    expect(screen.queryByRole("button", { name: "Remove level 1" })).toBeNull()
  })

  it("explains, on the level itself, an amount that is malformed or not higher than the one before", () => {
    render(<Harness initialEnabled initialLevels={["40000", "30000"]} />)

    expect(screen.getByText("Level 2's amount must be higher than Level 1's (PKR 40,000.00).")).toBeTruthy()
    expect(levelInput(2).getAttribute("aria-invalid")).toBe("true")
    expect(levelInput(1).hasAttribute("aria-invalid")).toBe(false)

    fireEvent.change(levelInput(1), { target: { value: "40k" } })
    expect(levelInput(1).getAttribute("aria-invalid")).toBe("true")
    const describedBy = levelInput(1).getAttribute("aria-describedby") ?? ""
    expect(document.getElementById(describedBy)?.textContent).toMatch(/Enter an amount in rupees/)
  })

  it("stops adding at the maximum number of levels", () => {
    const amounts = Array.from({ length: MAX_APPROVAL_LEVELS }, (_, index) => String((index + 1) * 1000))
    render(<Harness initialEnabled initialLevels={amounts} />)

    expect(addButton().disabled).toBe(true)
    expect(screen.getByText(`A company can have at most ${MAX_APPROVAL_LEVELS} approval levels.`)).toBeTruthy()
  })

  it("keeps the levels when switched off, so switching back on restores them", () => {
    const onChange = vi.fn()
    render(<Harness initialEnabled initialLevels={["40000", "80000"]} onChange={onChange} />)

    fireEvent.click(toggle())
    expect(isOn(toggle())).toBe(false)
    expect(screen.queryByLabelText("Level 1 approver")).toBeNull()
    fireEvent.click(toggle())

    expect(levelInput(1).value).toBe("40000")
    expect(levelInput(2).value).toBe("80000")
  })

  it("locks every control while saving", () => {
    render(<Harness initialEnabled initialLevels={["40000", "80000"]} disabled />)

    expect(toggle().disabled).toBe(true)
    expect(levelInput(1).disabled).toBe(true)
    expect(addButton().disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Remove level 2" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
