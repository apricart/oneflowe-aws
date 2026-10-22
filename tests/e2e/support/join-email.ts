import { createHmac, randomUUID } from "node:crypto"

import { expect, type Page } from "@playwright/test"

import { e2eNextAuthSecret } from "./environment"
import { testDatabaseUrl } from "./session"
import { queryTestDb } from "./tenant"

/**
 * The join page's email step (plans/OF-JOIN-email-otp-verification.md), with
 * the spec standing in for the mailbox.
 *
 * Neither environment this suite runs in has an email service, and the mail-out
 * answers a failed delivery with 503 rather than pretending, so the browser's
 * one call to it is answered here instead: a challenge row is planted for the
 * organization and the address, with the digest of a code this spec knows —
 * computed with the same HMAC the server checks — and the page is handed its
 * id. Everything after that is the application's own path: the verify step
 * issues the proof, and the submit spends it.
 *
 * The mail-out route itself is covered by `tests/integration/join-email-verification.test.ts`.
 */

const KNOWN_CODE = "135790"

function digest(value: string): string {
  return createHmac("sha256", e2eNextAuthSecret()).update(`oneflowe-join-email:v1:${value}`).digest("hex")
}

async function plantChallenge(joinCode: string, email: string): Promise<string> {
  const [organization] = await queryTestDb<{ organization_id: number }>(
    testDatabaseUrl(),
    "SELECT organization_id FROM organization_join_codes WHERE code = $1",
    [joinCode.trim().toUpperCase()],
  )
  if (!organization) throw new Error(`No organization holds the join code ${joinCode}`)

  const challengeId = randomUUID()
  const emailDigest = digest(`email:${email.trim().toLowerCase()}`)
  await queryTestDb(
    testDatabaseUrl(),
    `UPDATE join_email_verifications SET consumed_at = now()
      WHERE organization_id = $1 AND email_digest = $2 AND consumed_at IS NULL`,
    [organization.organization_id, emailDigest],
  )
  await queryTestDb(
    testDatabaseUrl(),
    `INSERT INTO join_email_verifications (id, organization_id, email_digest, code_digest, expires_at)
      VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
    [challengeId, organization.organization_id, emailDigest, digest(`code:${challengeId}:${KNOWN_CODE}`)],
  )
  return challengeId
}

/**
 * From the email step to the join form: types the part before the `@`, stands
 * in for the mail, and enters the code. Leaves the page on the form.
 */
export async function verifyJoinEmail(
  page: Page,
  input: { joinCode: string; localPart: string; domain: string },
): Promise<void> {
  const email = `${input.localPart}@${input.domain}`
  const route = "**/api/v1/join/email-verification/request"
  await page.route(route, async (request) => {
    const challengeId = await plantChallenge(input.joinCode, email)
    await request.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ challengeId, validForMinutes: 10 }),
    })
  })

  try {
    const field = page.locator("#join-verify-email")
    await expect(field).toBeVisible({ timeout: 150_000 })
    await field.fill(input.localPart)
    await page.getByRole("button", { name: /Send verification code/ }).click()

    const boxes = page.getByRole("group", { name: "Verification code" }).locator("input")
    await expect(boxes.first()).toBeVisible({ timeout: 150_000 })
    for (const [index, digit] of [...KNOWN_CODE].entries()) {
      await boxes.nth(index).fill(digit)
    }
    await page.getByRole("button", { name: /Verify and continue/ }).click()
    await expect(page.locator("#join-verify-email")).toHaveCount(0, { timeout: 150_000 })
  } finally {
    await page.unroute(route)
  }
}
