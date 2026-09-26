import { describe, expect, it } from "vitest"

import {
  ACTIVITY_MAX_WINDOW_DAYS,
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
  ACTIVITY_SOURCES,
  ACTIVITY_SOURCE_RANK,
  CATEGORY_RULES,
  METADATA_MASK,
  METADATA_MAX_DEPTH,
  METADATA_MAX_ENTRIES,
  MS_PER_DAY,
  OPERATION_RULES,
  SEVERITY_RULES,
  actionLabel,
  activitySourceOfRank,
  categoryOf,
  clampPageSize,
  cursorComparisonFor,
  decodeActivityCursor,
  encodeActivityCursor,
  entityLabel,
  maskAuditMetadata,
  operationOf,
  resolveWindow,
  severityOf,
  type ActivitySource,
} from "@/lib/activity-log"

/**
 * The activity log's pure rules.
 *
 * The classifier is asserted against the action strings the application really
 * writes, collected with
 * `grep -rhoE 'action: *"[A-Za-z_0-9]+"' app lib | sort -u`, rather than against
 * strings invented to match the rules — a classifier tested on its own examples
 * proves only that it was written down twice.
 */

describe("operationOf", () => {
  it.each([
    ["AUTH_LOGIN_SUCCESS", "auth"],
    ["AUTH_LOGIN_FAILURE", "auth"],
    ["AUTH_MFA_CHALLENGE", "auth"],
    ["AUTH_PASSWORD_CHANGED", "auth"],
    ["AUTH_ACCOUNT_LOCKED", "auth"],
    ["AUTH_SESSION_REVOKED", "auth"],
    ["CREATE", "create"],
    ["CREATE_BRANCH", "create"],
    ["CREATE_ORGANIZATION", "create"],
    ["CREATE_GROUP_ORDER", "create"],
    ["USER_CREATE", "create"],
    ["ORDER_CREATE", "create"],
    ["import_products", "create"],
    ["REFUND_REQUESTED", "create"],
    ["SEND_ORDER_TOKEN_EMAIL", "create"],
    ["UPDATE", "update"],
    ["UPDATE_GROUP", "update"],
    ["USER_ACCESS_UPDATE", "update"],
    ["UPDATE_ROLE_PERMISSIONS", "update"],
    ["CASCADE_UPDATE", "update"],
    ["CASCADE_CLEAR_OVERRIDE", "update"],
    ["PROPAGATE_ORGANIZATION_PRICE", "update"],
    ["SET_GROUP_PRICES", "update"],
    ["TOGGLE_GROUP_STATUS", "update"],
    ["RESET_ALL_QUANTITY_BUDGETS", "update"],
    ["RESTORE", "update"],
    ["ASSIGN_BRANCHES", "update"],
    ["ORDER_EDITED", "update"],
    ["update_global_product", "update"],
    ["EXPIRE_BUDGET_ADDON", "update"],
    ["DELETE", "delete"],
    ["DELETE_GROUP", "delete"],
    ["USER_DELETE", "delete"],
    ["BULK_DELETE", "delete"],
    ["CASCADE_DELETE", "delete"],
    ["delete_global_product", "delete"],
    ["CLEAN_BRANCH_PRODUCTS", "delete"],
    ["DEACTIVATE_BRANCH", "delete"],
    ["ORDER_APPROVED", "approve"],
    ["REFUND_APPROVED", "approve"],
    ["ORDER_AUTO_FULFILLED", "approve"],
    ["ORDER_FULFILLED_ON_DELIVERY", "approve"],
    ["ORDER_REJECTED", "reject"],
    ["REFUND_CANCELLED", "reject"],
    ["VIEW_GROUP_REPORT", "export"],
  ] as const)("classifies %s as %s", (action, expected) => {
    expect(operationOf(action)).toBe(expected)
  })

  it("is case-insensitive, because both spellings are already in the table", () => {
    expect(operationOf("delete_global_product")).toBe(operationOf("DELETE_GLOBAL_PRODUCT"))
    expect(operationOf("update_org_product")).toBe(operationOf("UPDATE_ORG_PRODUCT"))
  })

  it("falls back to other rather than guessing", () => {
    expect(operationOf("SOMETHING_NOBODY_PLANNED_FOR")).toBe("other")
    expect(operationOf("")).toBe("other")
  })

  it("does not let the noun decide the verb", () => {
    // The bug this guards: a CATEGORY rule ahead of the generic DELETE rule
    // made every category delete read as an update, and the operation filter
    // then agreed with the wrong label.
    expect(operationOf("DELETE_CATEGORY")).toBe("delete")
    expect(operationOf("CREATE_CATEGORY")).toBe("create")
    expect(operationOf("DELETE_SUPPLIER")).toBe("delete")
    expect(operationOf("DELETE_SUBCATEGORY")).toBe("delete")
    expect(operationOf("DELETE_MODIFIER")).toBe("delete")
    expect(operationOf("DELETE_REPORT_SCHEDULE")).toBe("delete")
  })

  it("reads a deactivation as a removal without swallowing an activation", () => {
    expect(operationOf("DEACTIVATE_BRANCH")).toBe("delete")
    expect(operationOf("ACTIVATE_BRANCH")).toBe("update")
  })

  // Every action string the centralized writer emits. A new one that classifies
  // as `other` is one the screen cannot group or filter, so each is pinned here.
  it.each([
    ["ORDER_FULFILLED", "approve"],
    ["DELETE_ORDER", "delete"],
    ["UPLOAD_IMAGE", "create"],
    ["UPLOAD_SUPPORT_ATTACHMENT", "create"],
    ["CREATE_SUPPORT_THREAD", "create"],
    ["REPLY_SUPPORT_THREAD", "create"],
    ["UPDATE_SUPPORT_THREAD", "update"],
    ["RESET_BRANCH_BUDGETS", "update"],
    ["REBUILD_BRANCH_BUDGETS", "create"],
    ["CLEANUP_ORGANIZATION_INVENTORY_NAMES", "update"],
    ["MIGRATE_SCHEMA", "update"],
    ["SEND_SCHEDULED_REPORT", "export"],
    ["AUTH_MFA_ENABLED", "auth"],
    ["AUTH_MFA_DISABLED", "auth"],
    ["AUTH_MFA_VERIFIED", "auth"],
  ] as const)("classifies the written action %s as %s", (action, expected) => {
    expect(operationOf(action)).toBe(expected)
  })

  it("tells a bulk field clear from a bulk row removal", () => {
    // `CLEANUP_` nulls a column; `CLEAN_` deletes rows. They differ by one
    // underscore, so the order of the two rules is what keeps them apart.
    expect(operationOf("CLEANUP_ORGANIZATION_INVENTORY_NAMES")).toBe("update")
    expect(operationOf("CLEAN_BRANCH_PRODUCTS")).toBe("delete")
  })

  it("reads a report leaving the application as an export, not a send", () => {
    expect(operationOf("SEND_SCHEDULED_REPORT")).toBe("export")
    // While an ordinary send stays a create.
    expect(operationOf("SEND_ORDER_TOKEN_EMAIL")).toBe("create")
  })
})

describe("categoryOf", () => {
  it.each([
    ["AUTH_LOGIN_SUCCESS", "authentication"],
    ["AUTH_PASSWORD_CHANGED", "authentication"],
    ["UPDATE_ROLE_PERMISSIONS", "system"],
    ["UPDATE_ORDER_APPROVER_ROLE", "system"],
    ["SET_GROUP_PRICES", "pricing"],
    ["PROPAGATE_ORGANIZATION_PRICE", "pricing"],
    ["REFUND_APPROVED", "refund"],
    ["RESET_ALL_QUANTITY_BUDGETS", "budget"],
    ["EXPIRE_BUDGET_ADDON", "budget"],
    ["ORDER_APPROVED", "order"],
    ["CREATE_GROUP", "group"],
    ["CREATE_ORGANIZATION", "organization"],
    ["CREATE_BRANCH", "branch"],
    ["USER_DELETE", "user"],
    ["CREATE_EMPLOYEE_CREDENTIAL", "user"],
    ["DELETE_CATEGORY", "catalogue"],
    ["UPDATE_SUBCATEGORY", "catalogue"],
    ["DELETE_SUPPLIER", "catalogue"],
    ["CREATE_MODIFIER", "catalogue"],
    ["update_global_product", "catalogue"],
    ["CLEAN_BRANCH_PRODUCTS", "catalogue"],
    ["DELETE_SETTING", "settings"],
    ["UPDATE_PRIVATE_NETWORK_LOGIN", "settings"],
    ["CREATE_REPORT_SCHEDULE", "reports"],
  ] as const)("files %s under %s", (action, expected) => {
    expect(categoryOf(action)).toBe(expected)
  })

  it("puts privilege ahead of the person it was granted to", () => {
    // `UPDATE_ROLE_PERMISSIONS` contains no noun but ROLE; a USER rule ahead of
    // it would file an escalation as ordinary account maintenance.
    expect(categoryOf("UPDATE_USER_ROLE")).toBe("system")
  })

  it("falls back to system", () => {
    expect(categoryOf("SOMETHING_ELSE")).toBe("system")
  })

  it.each([
    ["CREATE_SUPPORT_THREAD", "support"],
    ["REPLY_SUPPORT_THREAD", "support"],
    ["UPDATE_SUPPORT_THREAD", "support"],
    ["UPLOAD_SUPPORT_ATTACHMENT", "support"],
    ["ORDER_FULFILLED", "order"],
    ["DELETE_ORDER", "order"],
    ["RESET_BRANCH_BUDGETS", "budget"],
    ["REBUILD_BRANCH_BUDGETS", "budget"],
    ["CLEANUP_ORGANIZATION_INVENTORY_NAMES", "inventory"],
    ["SEND_SCHEDULED_REPORT", "reports"],
    ["AUTH_MFA_DISABLED", "authentication"],
  ] as const)("files the written action %s under %s", (action, expected) => {
    expect(categoryOf(action)).toBe(expected)
  })

  it("keeps a support thread about an order under support", () => {
    // Support is matched before ORDER on purpose: the thread is the thing that
    // was touched, and a reviewer looking for support activity wants it there.
    expect(categoryOf("CREATE_SUPPORT_THREAD_FOR_ORDER")).toBe("support")
  })
})

describe("severityOf", () => {
  it("marks a removal critical", () => {
    expect(severityOf("DELETE_CATEGORY")).toBe("critical")
    expect(severityOf("BULK_DELETE")).toBe("critical")
  })

  it("marks a privilege or price change critical", () => {
    expect(severityOf("UPDATE_ROLE_PERMISSIONS")).toBe("critical")
    expect(severityOf("SET_GROUP_PRICES")).toBe("critical")
    expect(severityOf("USER_ACCESS_UPDATE")).toBe("critical")
    expect(severityOf("AUTH_PASSWORD_CHANGED")).toBe("critical")
  })

  it("takes the highest of the rules that apply, not the first", () => {
    // A user delete is a delete (critical) of a user (notice). Reading either
    // one first would let it decide for the other.
    expect(severityOf("USER_DELETE")).toBe("critical")
  })

  it("raises a failure to at least a warning", () => {
    expect(severityOf("AUTH_LOGIN_SUCCESS")).toBe("info")
    expect(severityOf("AUTH_LOGIN_SUCCESS", false)).toBe("warning")
  })

  it("never lets a failure make a row matter less", () => {
    expect(severityOf("DELETE_CATEGORY", false)).toBe("critical")
    expect(severityOf("AUTH_PASSWORD_CHANGED", false)).toBe("critical")
  })

  it("leaves routine activity as info", () => {
    expect(severityOf("UPDATE_CATEGORY")).toBe("info")
    expect(severityOf("AUTH_MFA_CHALLENGE")).toBe("info")
  })

  it("marks removing a second factor critical, and adding one merely notable", () => {
    // Turning MFA off is removing a security control, and is among the first
    // things somebody holding a stolen session would do.
    expect(severityOf("AUTH_MFA_DISABLED")).toBe("critical")
    expect(severityOf("AUTH_MFA_ENABLED")).toBe("info")
  })

  it.each([
    // Destroys a branch's entire budget history.
    ["RESET_BRANCH_BUDGETS", "critical"],
    ["REBUILD_BRANCH_BUDGETS", "critical"],
    // Reaches every matching row in the table.
    ["CLEANUP_ORGANIZATION_INVENTORY_NAMES", "critical"],
    // A schema change applied over HTTP instead of through a migration.
    ["MIGRATE_SCHEMA", "critical"],
    // A hard delete of an order.
    ["DELETE_ORDER", "critical"],
  ] as const)("marks %s critical", (action, expected) => {
    expect(severityOf(action)).toBe(expected)
  })

  it("marks a tenant's figures leaving the application notable", () => {
    expect(severityOf("SEND_SCHEDULED_REPORT")).toBe("notice")
  })
})

describe("the rule tables", () => {
  it("has no unreachable rule", () => {
    // A rule fully shadowed by an earlier one is dead weight that reads as a
    // statement of intent. Each rule must be the first to claim its own value.
    for (const rules of [OPERATION_RULES, CATEGORY_RULES, SEVERITY_RULES]) {
      rules.forEach((rule, index) => {
        const earlier = rules.slice(0, index)
        const shadowed = earlier.some(
          (other) => other.kind === "contains" && rule.value.includes(other.value),
        )
        expect(shadowed, `${rule.kind} "${rule.value}" is shadowed by an earlier rule`).toBe(false)
      })
    }
  })

  it("writes every rule value in upper case, because matching upper-cases first", () => {
    for (const rules of [OPERATION_RULES, CATEGORY_RULES, SEVERITY_RULES]) {
      for (const rule of rules) {
        expect(rule.value).toBe(rule.value.toUpperCase())
      }
    }
  })
})

describe("labels", () => {
  it("reads an action as a sentence without hiding it", () => {
    expect(actionLabel("AUTH_LOGIN_SUCCESS")).toBe("Auth login success")
    expect(actionLabel("import_products")).toBe("Import products")
    expect(actionLabel("  ")).toBe("Unknown action")
    expect(actionLabel(null)).toBe("Unknown action")
  })

  it("reads an entity name whichever convention wrote it", () => {
    expect(entityLabel("organization_settings")).toBe("Organization settings")
    expect(entityLabel("GlobalProduct")).toBe("Global product")
    expect(entityLabel("BranchInventory")).toBe("Branch inventory")
    expect(entityLabel(null)).toBe("—")
  })
})

describe("the cursor", () => {
  it("round-trips", () => {
    for (const source of ACTIVITY_SOURCES) {
      const cursor = { occurredAtMs: 1_767_225_600_000, source, id: 987_654 }
      expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor)
    }
  })

  it.each([
    ["empty", ""],
    ["not base64", "!!!!"],
    ["too few parts", Buffer.from("123.1", "utf8").toString("base64url")],
    ["a source rank nothing maps to", Buffer.from("123.9.4", "utf8").toString("base64url")],
    ["a negative id", Buffer.from("123.1.-4", "utf8").toString("base64url")],
    ["a non-numeric timestamp", Buffer.from("abc.1.4", "utf8").toString("base64url")],
    ["far too long", "A".repeat(300)],
  ])("rejects %s", (_name, value) => {
    expect(decodeActivityCursor(value)).toBeNull()
  })

  it("rejects null and undefined", () => {
    expect(decodeActivityCursor(null)).toBeNull()
    expect(decodeActivityCursor(undefined)).toBeNull()
  })

  it("maps every rank back to its source and nothing else to one", () => {
    for (const source of ACTIVITY_SOURCES) {
      expect(activitySourceOfRank(ACTIVITY_SOURCE_RANK[source])).toBe(source)
    }
    expect(activitySourceOfRank(0)).toBeNull()
    expect(activitySourceOfRank(99)).toBeNull()
  })

  it("gives every source a distinct rank, so the sort is total", () => {
    const ranks = ACTIVITY_SOURCES.map((source) => ACTIVITY_SOURCE_RANK[source])
    expect(new Set(ranks).size).toBe(ranks.length)
  })
})

describe("cursorComparisonFor", () => {
  it("treats the cursor's own source as the one that must skip past an id", () => {
    for (const source of ACTIVITY_SOURCES) {
      expect(cursorComparisonFor(source, source)).toBe("same")
    }
  })

  it("includes an equal timestamp only for a source that sorts after the cursor", () => {
    // The page sorts rank DESC, so group (3) comes before system (2) before
    // audit (1). A cursor stopping at group leaves system and audit rows at that
    // same timestamp still unread.
    expect(cursorComparisonFor("system", "group")).toBe("after")
    expect(cursorComparisonFor("audit", "group")).toBe("after")
    expect(cursorComparisonFor("audit", "system")).toBe("after")
  })

  it("excludes an equal timestamp for a source already read", () => {
    expect(cursorComparisonFor("group", "audit")).toBe("before")
    expect(cursorComparisonFor("system", "audit")).toBe("before")
    expect(cursorComparisonFor("group", "system")).toBe("before")
  })

  it("covers every ordered pair exactly once, in one direction each", () => {
    const pairs: [ActivitySource, ActivitySource][] = []
    for (const a of ACTIVITY_SOURCES) {
      for (const b of ACTIVITY_SOURCES) {
        if (a !== b) pairs.push([a, b])
      }
    }
    for (const [a, b] of pairs) {
      const forward = cursorComparisonFor(a, b)
      const backward = cursorComparisonFor(b, a)
      expect(forward).not.toBe("same")
      expect(forward).not.toBe(backward)
    }
  })
})

describe("clampPageSize", () => {
  it("defaults when nothing usable is given", () => {
    expect(clampPageSize(undefined)).toBe(ACTIVITY_PAGE_SIZE_DEFAULT)
    expect(clampPageSize(null)).toBe(ACTIVITY_PAGE_SIZE_DEFAULT)
    expect(clampPageSize(Number.NaN)).toBe(ACTIVITY_PAGE_SIZE_DEFAULT)
  })

  it("bounds both ends", () => {
    expect(clampPageSize(0)).toBe(1)
    expect(clampPageSize(-10)).toBe(1)
    expect(clampPageSize(ACTIVITY_PAGE_SIZE_MAX + 1)).toBe(ACTIVITY_PAGE_SIZE_MAX)
    expect(clampPageSize(10_000)).toBe(ACTIVITY_PAGE_SIZE_MAX)
  })

  it("keeps a whole number in range", () => {
    expect(clampPageSize(25)).toBe(25)
    expect(clampPageSize(25.9)).toBe(25)
  })
})

describe("resolveWindow", () => {
  const now = new Date("2026-09-26T12:00:00.000Z")

  it("defaults to the recent past so the first read is bounded", () => {
    const result = resolveWindow(null, null, now)
    expect("window" in result).toBe(true)
    if (!("window" in result)) return
    expect(result.window.to).toEqual(now)
    expect((now.getTime() - result.window.from.getTime()) / MS_PER_DAY).toBe(7)
  })

  it("accepts an explicit range inside the maximum", () => {
    const from = new Date("2026-09-01T00:00:00.000Z")
    const to = new Date("2026-09-20T00:00:00.000Z")
    const result = resolveWindow(from, to, now)
    expect(result).toEqual({ window: { from, to } })
  })

  it("refuses rather than truncating an over-long range", () => {
    // Truncating would read as "nothing happened" for the part silently dropped.
    const to = new Date("2026-09-20T00:00:00.000Z")
    const from = new Date(to.getTime() - (ACTIVITY_MAX_WINDOW_DAYS + 1) * MS_PER_DAY)
    const result = resolveWindow(from, to, now)
    expect(result).toEqual({ error: expect.stringContaining("exceed") })
  })

  it("accepts exactly the maximum", () => {
    const to = new Date("2026-09-20T00:00:00.000Z")
    const from = new Date(to.getTime() - ACTIVITY_MAX_WINDOW_DAYS * MS_PER_DAY)
    expect("window" in resolveWindow(from, to, now)).toBe(true)
  })

  it("refuses a reversed range", () => {
    const result = resolveWindow(
      new Date("2026-09-20T00:00:00.000Z"),
      new Date("2026-09-01T00:00:00.000Z"),
      now,
    )
    expect(result).toEqual({ error: expect.stringContaining("later") })
  })

  it("refuses an unparseable date", () => {
    expect(resolveWindow(new Date("nonsense"), null, now)).toEqual({
      error: expect.stringContaining("valid"),
    })
  })
})

describe("maskAuditMetadata", () => {
  it("masks anything that looks like a secret, at any depth", () => {
    expect(
      maskAuditMetadata({
        password: "hunter2",
        apiKey: "k",
        nested: { refreshToken: "t", authorization: "Bearer x", credential: "c" },
        safe: "kept",
      }),
    ).toEqual({
      password: METADATA_MASK,
      apiKey: METADATA_MASK,
      nested: {
        refreshToken: METADATA_MASK,
        authorization: METADATA_MASK,
        credential: METADATA_MASK,
      },
      safe: "kept",
    })
  })

  it("keeps an array an array", () => {
    // `maskSensitiveData` in lib/error-handler.ts spreads with `{...data}`,
    // which turns [1,2] into {0:1,1:2}. An audit payload's arrays have to stay
    // recognisable to whoever reads the row.
    expect(maskAuditMetadata({ ids: [1, 2, 3] })).toEqual({ ids: [1, 2, 3] })
    expect(Array.isArray((maskAuditMetadata({ ids: [1] }) as { ids: unknown }).ids)).toBe(true)
  })

  it("survives a cycle", () => {
    const cyclic: Record<string, unknown> = { name: "a" }
    cyclic.self = cyclic
    expect(maskAuditMetadata(cyclic)).toEqual({ name: "a", self: "[circular]" })
  })

  it("bounds depth", () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < METADATA_MAX_DEPTH + 3; i += 1) deep = { child: deep }
    expect(JSON.stringify(maskAuditMetadata(deep))).toContain("[truncated]")
  })

  it("bounds a long array and says how much it dropped", () => {
    const long = Array.from({ length: METADATA_MAX_ENTRIES + 5 }, (_, index) => index)
    const masked = maskAuditMetadata(long) as unknown[]
    expect(masked).toHaveLength(METADATA_MAX_ENTRIES + 1)
    expect(masked.at(-1)).toBe("[5 more]")
  })

  it("leaves primitives and null alone", () => {
    expect(maskAuditMetadata(null)).toBeNull()
    expect(maskAuditMetadata(undefined)).toBeUndefined()
    expect(maskAuditMetadata(5)).toBe(5)
    expect(maskAuditMetadata("plain")).toBe("plain")
  })

  it("renders a date as an ISO string rather than an empty object", () => {
    expect(maskAuditMetadata({ at: new Date("2026-09-26T00:00:00.000Z") })).toEqual({
      at: "2026-09-26T00:00:00.000Z",
    })
  })
})
