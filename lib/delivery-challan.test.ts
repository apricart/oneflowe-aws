import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  DELIVERY_CHALLAN_CONTENT_TYPES,
  MAX_DELIVERY_CHALLAN_BYTES,
  contentTypeForDeliveryChallanKey,
  deliveryChallanContentDisposition,
  isDeliveryChallanKey,
  sanitizeDeliveryChallanFileName,
} from "@/lib/delivery-challan"
import { isValidImageKey } from "@/lib/server/image-storage"
import { fulfillmentStatusSchema } from "@/lib/server/mutation-validation"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")
const KEY = "delivery-challan/0f8fad5b-d9cb-469f-a165-70867728950e.pdf"

describe("delivery challan rules", () => {
  it("accepts images and PDFs only, up to 4 MB, as the database does", () => {
    expect(DELIVERY_CHALLAN_CONTENT_TYPES).toEqual(["image/jpeg", "image/png", "image/webp", "application/pdf"])
    expect(MAX_DELIVERY_CHALLAN_BYTES).toBe(4_194_304)
    const migration = read("drizzle/20261008120000_add_order_delivery_challans.sql")
    expect(migration).toContain("IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')")
    expect(migration).toContain('"size_bytes" <= 4194304')
  })

  it("recognises only keys of its own exact shape", () => {
    expect(isDeliveryChallanKey(KEY)).toBe(true)
    expect(contentTypeForDeliveryChallanKey(KEY)).toBe("application/pdf")
    expect(contentTypeForDeliveryChallanKey(KEY.replace(".pdf", ".jpg"))).toBe("image/jpeg")
    for (const probe of [
      "delivery-challan/../products/x.jpg",
      "products/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
      `${KEY}.exe`,
      KEY.replace(".pdf", ".html"),
      KEY.toUpperCase(),
    ]) {
      expect(isDeliveryChallanKey(probe), probe).toBe(false)
      expect(contentTypeForDeliveryChallanKey(probe), probe).toBeNull()
    }
  })

  it("can never be served by the public image route", () => {
    expect(isValidImageKey(KEY)).toBe(false)
    expect(isValidImageKey(KEY.replace(".pdf", ".jpg"))).toBe(false)
  })

  it("cleans the uploader's file name and names the real type", () => {
    expect(sanitizeDeliveryChallanFileName("challan 12.PDF", "pdf")).toBe("challan 12.pdf")
    expect(sanitizeDeliveryChallanFileName("../../etc/passwd", "jpg")).toBe("passwd.jpg")
    expect(sanitizeDeliveryChallanFileName("C:\\scans\\dc.png", "png")).toBe("dc.png")
    expect(sanitizeDeliveryChallanFileName('a"b<script>.jpg', "jpg")).toBe("a_b_script.jpg")
    expect(sanitizeDeliveryChallanFileName("report.exe", "pdf")).toBe("report.pdf")
    expect(sanitizeDeliveryChallanFileName("", "webp")).toBe("delivery-challan.webp")
    expect(sanitizeDeliveryChallanFileName(undefined, "pdf")).toBe("delivery-challan.pdf")
    expect(sanitizeDeliveryChallanFileName("x".repeat(400), "pdf").length).toBeLessThanOrEqual(124)
  })

  it("downloads a PDF and shows an image, with a header-safe file name", () => {
    expect(deliveryChallanContentDisposition("application/pdf", "challan.pdf"))
      .toBe(`attachment; filename="challan.pdf"; filename*=UTF-8''challan.pdf`)
    expect(deliveryChallanContentDisposition("image/png", "چالان.png")).toMatch(/^inline; filename="_+\.png"; filename\*=UTF-8''%/)
  })
})

describe("the delivered transition", () => {
  it("requires a challan to mark delivered, and refuses one at any other stage", () => {
    expect(fulfillmentStatusSchema.safeParse({ fulfillmentStatus: "DELIVERED" }).success).toBe(false)
    expect(fulfillmentStatusSchema.safeParse({ fulfillmentStatus: "DELIVERED", deliveryChallanId: 5 }).success).toBe(true)
    expect(fulfillmentStatusSchema.safeParse({ fulfillmentStatus: "IN_PROCESS" }).success).toBe(true)
    expect(fulfillmentStatusSchema.safeParse({ fulfillmentStatus: "IN_PROCESS", deliveryChallanId: 5 }).success).toBe(false)
    expect(fulfillmentStatusSchema.safeParse({ fulfillmentStatus: "DELIVERED", deliveryChallanId: 0 }).success).toBe(false)
    expect(fulfillmentStatusSchema.safeParse({ fulfillmentStatus: "DELIVERED", deliveryChallanId: 5, extra: 1 }).success).toBe(false)
  })
})

describe("the challan routes", () => {
  it("attach the challan inside the delivery's own transaction", () => {
    const progress = read("app/api/v1/orders/[id]/fulfillment-status/route.ts")
    expect(progress).toContain('requireApiRole(["SUPER_ADMIN"])')
    // Super Admin's delivery still needs its challan; the shared transition
    // (also the warehouse's, where it is optional) attaches it.
    expect(progress).toContain("challanRequired: true")
    const transition = read("lib/server/order-fulfillment-progress.ts")
    expect(transition).toContain("await attachDeliveryChallan(tx, {")
    expect(transition).toContain("if (!attached) throw new Error(DELIVERY_CHALLAN_NOT_ATTACHABLE)")
    expect(transition).toContain("nextStatus === \"DELIVERED\" && challanRequired && deliveryChallanId === null")
    const store = read("lib/server/delivery-challan.ts")
    expect(store).toContain("eq(orderDeliveryChallans.uploadedByUserId, input.actorUserId)")
    expect(store).toContain("isNull(orderDeliveryChallans.attachedAt)")
  })

  it("let only Super Admin and the warehouse upload one, whoever else the upload route admits", () => {
    const upload = read("app/api/v1/upload/image/route.ts")
    expect(upload).toContain("if (formData.get(\"purpose\") === DELIVERY_CHALLAN_UPLOAD_PURPOSE)")
    expect(upload).toMatch(/async function storeDeliveryChallan[\s\S]*?if \(userRole !== "SUPER_ADMIN" && !isWarehouseRole\(userRole\)\)/)
    // The warehouse only for an order at a branch it serves
    // (plans/OF-WAREHOUSE-warehouse-fulfilment-role.md) ...
    expect(upload).toMatch(/async function storeDeliveryChallan[\s\S]*?warehouseChallanUploadRefusal\(actor\.id, orderId\)/)
    // ... and never anything but a challan.
    expect(upload).toMatch(/DELIVERY_CHALLAN_UPLOAD_PURPOSE\)[\s\S]*?if \(isWarehouseRole\(userRole\)\) \{\s*return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/)
  })

  it("read with exactly the order detail's rule", () => {
    for (const route of [
      "app/api/v1/orders/[id]/delivery-challan/route.ts",
      "app/api/v1/orders/[id]/delivery-challan/[challanId]/file/route.ts",
    ]) {
      const source = read(route)
      expect(source, route).toContain("requireApiRole([...ORDER_DETAIL_READ_ROLES])")
      expect(source, route).toContain("await canReadOrderDetail({ orderId, scope })")
    }
    const detail = read("app/api/v1/orders/[id]/route.ts")
    expect(detail).toContain('import { hasBranchAccessForOrderRead } from "@/lib/server/order-read-access"')
    // The shared role list is exactly the order detail's allowlist.
    expect(detail).toContain('requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "GROUP_ORDER_PORTAL", "ORDER_PORTAL"])')
    expect(read("lib/server/order-read-access.ts")).toContain(`export const ORDER_DETAIL_READ_ROLES = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "GROUP_USER",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
] as const`)
  })

  it("serve the file privately, unsniffed, sandboxed, and a PDF as a download", () => {
    const file = read("app/api/v1/orders/[id]/delivery-challan/[challanId]/file/route.ts")
    expect(file).toContain('"Cache-Control": "private, no-store, max-age=0"')
    expect(file).toContain('"X-Content-Type-Options": "nosniff"')
    expect(file).toContain("sandbox")
    expect(file).toContain("deliveryChallanContentDisposition(contentType, file.fileName)")
  })

  it("stay out of the Order Desk's and the executive's API allowlists", () => {
    for (const allowlist of ["lib/order-desk-access.ts", "lib/apricart-executive-access.ts"]) {
      expect(read(allowlist), allowlist).not.toContain("delivery-challan")
    }
  })
})
