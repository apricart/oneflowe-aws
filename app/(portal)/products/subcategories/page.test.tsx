import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  toast: vi.fn(),
}))

vi.mock("swr", () => ({
  default: (key: string) => {
    if (key.startsWith("/api/v1/categories")) {
      return {
        data: { items: [{ id: 10, name: "Beverages" }] },
        isLoading: false,
      }
    }

    return {
      data: {
        items: [
          {
            id: 20,
            name: "Coffee",
            parentId: 10,
            categoryName: "Beverages",
            productsCount: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        pagination: { page: 1, limit: 10, total: 1, pages: 1 },
      },
      isLoading: false,
      mutate: mocks.mutate,
    }
  },
}))

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}))

import SubcategoriesPage from "./page"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SubcategoriesPage count labels", () => {
  it("uses singular labels when one subcategory and product are shown", () => {
    render(<SubcategoriesPage />)

    expect(screen.getByText("1 subcategory in total")).toBeTruthy()
    expect(screen.getByText("1 product")).toBeTruthy()
    expect(screen.queryByText("1 subcategories in total")).toBeNull()
    expect(screen.queryByText("1 products")).toBeNull()
  })
})
