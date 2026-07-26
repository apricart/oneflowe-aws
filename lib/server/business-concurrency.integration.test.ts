// Requires an explicitly isolated PostgreSQL database. The normal application
// DATABASE_URL is intentionally never used by this destructive concurrency suite.
import { randomUUID } from "node:crypto"
import { Pool, type PoolClient } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const schema = `business_concurrency_${randomUUID().replace(/-/g, "")}`
const pool = testDatabaseUrl ? new Pool({ connectionString: testDatabaseUrl, max: 20 }) : null

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("TEST_DATABASE_URL is required")
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await operation(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

describe.skipIf(!testDatabaseUrl)("PostgreSQL simultaneous business mutations", () => {
  beforeAll(async () => {
    await pool!.query(`CREATE SCHEMA "${schema}"`)
    await pool!.query(`
      CREATE TABLE "${schema}".budget (id integer PRIMARY KEY, allocated bigint NOT NULL, spent bigint NOT NULL, held bigint NOT NULL);
      CREATE TABLE "${schema}".stock (id integer PRIMARY KEY, quantity numeric NOT NULL);
      CREATE TABLE "${schema}".workflow (id integer PRIMARY KEY, status text NOT NULL);
      CREATE TABLE "${schema}".payment (id integer PRIMARY KEY, paid boolean NOT NULL, total bigint NOT NULL, refunded bigint NOT NULL);
      CREATE TABLE "${schema}".invoice_sequence (id integer PRIMARY KEY, value integer NOT NULL);
    `)
  })

  afterAll(async () => {
    if (!pool) return
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await pool.end()
  })

  it("allows only one request to spend the same remaining budget", async () => {
    await pool!.query(`INSERT INTO "${schema}".budget VALUES (1, 100, 0, 0)`)
    const spend = () => inTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM "${schema}".budget WHERE id = 1 FOR UPDATE`)
      const budget = rows[0]
      if (Number(budget.allocated) - Number(budget.spent) - Number(budget.held) < 100) return false
      await client.query(`UPDATE "${schema}".budget SET held = held + 100 WHERE id = 1`)
      return true
    })
    expect((await Promise.all([spend(), spend()])).filter(Boolean)).toHaveLength(1)
  })

  it("allows only one request to buy the last inventory unit", async () => {
    await pool!.query(`INSERT INTO "${schema}".stock VALUES (1, 1)`)
    const buy = () => inTransaction(async (client) => {
      const { rows } = await client.query(`SELECT quantity FROM "${schema}".stock WHERE id = 1 FOR UPDATE`)
      if (Number(rows[0].quantity) < 1) return false
      await client.query(`UPDATE "${schema}".stock SET quantity = quantity - 1 WHERE id = 1`)
      return true
    })
    expect((await Promise.all([buy(), buy()])).filter(Boolean)).toHaveLength(1)
  })

  it.each([
    ["approve", "PENDING", "APPROVED"],
    ["fulfil", "APPROVED", "FULFILLED"],
  ])("allows only one request to %s an order", async (_label, from, to) => {
    await pool!.query(`INSERT INTO "${schema}".workflow VALUES (1, $1)`, [from])
    const transition = () => pool!.query(
      `UPDATE "${schema}".workflow SET status = $1 WHERE id = 1 AND status = $2 RETURNING id`,
      [to, from],
    ).then((result) => result.rowCount === 1)
    expect((await Promise.all([transition(), transition()])).filter(Boolean)).toHaveLength(1)
    await pool!.query(`DELETE FROM "${schema}".workflow WHERE id = 1`)
  })

  it("allows only one request to refund the same paid amount", async () => {
    await pool!.query(`INSERT INTO "${schema}".payment VALUES (1, true, 100, 0)`)
    const refund = () => inTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM "${schema}".payment WHERE id = 1 FOR UPDATE`)
      const payment = rows[0]
      if (!payment.paid || Number(payment.total) - Number(payment.refunded) < 100) return false
      await client.query(`UPDATE "${schema}".payment SET refunded = refunded + 100 WHERE id = 1`)
      return true
    })
    expect((await Promise.all([refund(), refund()])).filter(Boolean)).toHaveLength(1)
  })

  it("generates unique invoice values under simultaneous requests", async () => {
    await pool!.query(`INSERT INTO "${schema}".invoice_sequence VALUES (1, 0)`)
    const results = await Promise.all(Array.from({ length: 50 }, () =>
      pool!.query(`UPDATE "${schema}".invoice_sequence SET value = value + 1 WHERE id = 1 RETURNING value`)
        .then((result) => Number(result.rows[0].value))
    ))
    expect(new Set(results).size).toBe(50)
    expect(Math.max(...results)).toBe(50)
  })
})
