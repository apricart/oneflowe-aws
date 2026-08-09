#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const INPUT = resolve(process.argv[2] || "updatedReports/ke-receivables-reconciliation-2026-08-06/match-source.json")
const OUTPUT = resolve(process.argv[3] || "updatedReports/ke-receivables-reconciliation-2026-08-06/candidate-analysis.json")

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/peak|freens/g, (value) => value === "peak" ? "peek" : "freans")
    .replace(/everday/g, "everyday")
    .replace(/h[iy]-?jeen|hygiene|hygeine/g, "hijeen")
    .replace(/choclate/g, "chocolate")
    .replace(/coffe(?!e)/g, "coffee")
    .replace(/cadimum/g, "cardamom")
    .replace(/teabags|tea\s+bags/g, "teabag")
    .replace(/pieces|piece|pcs|pc\b/g, "pcs")
    .replace(/grams?|gms?|gm\b/g, "gm")
    .replace(/litres?|liters?|litre|liter|ltr/g, "ltr")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function bigramDice(left: unknown, right: unknown): number {
  const a = normalize(left).replace(/\s/g, "")
  const b = normalize(right).replace(/\s/g, "")
  if (a === b) return a ? 1 : 0
  if (a.length < 2 || b.length < 2) return 0
  const counts = new Map<string, number>()
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  let matches = 0
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2)
    const count = counts.get(gram) ?? 0
    if (!count) continue
    matches += 1
    counts.set(gram, count - 1)
  }
  return 2 * matches / (a.length + b.length - 2)
}

function tokenDice(left: unknown, right: unknown): number {
  const a = new Set(normalize(left).split(" ").filter(Boolean))
  const b = new Set(normalize(right).split(" ").filter(Boolean))
  if (!a.size || !b.size) return 0
  let matches = 0
  for (const token of a) if (b.has(token)) matches += 1
  return 2 * matches / (a.size + b.size)
}

function nameSimilarity(left: unknown, right: unknown): number {
  return 0.55 * bigramDice(left, right) + 0.45 * tokenDice(left, right)
}

function containmentScore(container: unknown, target: unknown): number {
  const containerTokens = new Set(normalize(container).split(" ").filter((token) => token.length > 1))
  const targetTokens = normalize(target).split(" ").filter((token) => token.length > 1)
  if (!containerTokens.size || !targetTokens.length) return 0
  return targetTokens.filter((token) => containerTokens.has(token)).length / targetTokens.length
}

function ratioSimilarity(left: number, right: number): number {
  if (left === right) return 1
  if (left <= 0 || right <= 0) return 0
  return Math.exp(-Math.abs(Math.log(left / right)))
}

function daysBetween(left: string, right: string): number {
  return Math.round((new Date(`${left}T00:00:00Z`).getTime() - new Date(`${right}T00:00:00Z`).getTime()) / 86_400_000)
}

function maximumAssignment(scores: number[][]): Array<[number, number]> {
  const rowCount = scores.length
  const columnCount = scores[0]?.length ?? 0
  const size = Math.max(rowCount, columnCount)
  if (!size) return []
  const cost = Array.from({ length: size + 1 }, (_, row) =>
    Array.from({ length: size + 1 }, (_, column) => {
      if (!row || !column || row > rowCount || column > columnCount) return 1
      return 1 - scores[row - 1][column - 1]
    }),
  )
  const u = Array(size + 1).fill(0)
  const v = Array(size + 1).fill(0)
  const p = Array(size + 1).fill(0)
  const way = Array(size + 1).fill(0)
  for (let row = 1; row <= size; row += 1) {
    p[0] = row
    let column0 = 0
    const minv = Array(size + 1).fill(Number.POSITIVE_INFINITY)
    const used = Array(size + 1).fill(false)
    do {
      used[column0] = true
      const row0 = p[column0]
      let delta = Number.POSITIVE_INFINITY
      let column1 = 0
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue
        const current = cost[row0][column] - u[row0] - v[column]
        if (current < minv[column]) {
          minv[column] = current
          way[column] = column0
        }
        if (minv[column] < delta) {
          delta = minv[column]
          column1 = column
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          u[p[column]] += delta
          v[column] -= delta
        } else {
          minv[column] -= delta
        }
      }
      column0 = column1
    } while (p[column0] !== 0)
    do {
      const column1 = way[column0]
      p[column0] = p[column1]
      column0 = column1
    } while (column0 !== 0)
  }
  const result: Array<[number, number]> = []
  for (let column = 1; column <= size; column += 1) {
    const row = p[column]
    if (row >= 1 && row <= rowCount && column <= columnCount) result.push([row - 1, column - 1])
  }
  return result
}

function itemComparison(invoice: Row, order: Row) {
  const components = invoice.items.map((warehouseItem: Row) => order.items.map((databaseItem: Row) => {
    const productName = nameSimilarity(warehouseItem.itemName, databaseItem.productName)
    const quantity = ratioSimilarity(Number(warehouseItem.quantity), Number(databaseItem.quantity))
    const lineAmount = ratioSimilarity(Number(warehouseItem.totalCents), Number(databaseItem.subtotalCents))
    return {
      score: 0.62 * productName + 0.12 * quantity + 0.26 * lineAmount,
      productName,
      quantity,
      lineAmount,
    }
  }))
  const assignment = maximumAssignment(components.map((row: Row[]) => row.map((component) => component.score)))
  const matches = assignment.map(([warehouseIndex, databaseIndex]) => ({
    warehouseIndex,
    databaseIndex,
    warehouseItem: invoice.items[warehouseIndex],
    databaseItem: order.items[databaseIndex],
    ...components[warehouseIndex][databaseIndex],
  }))
  const denominator = Math.max(invoice.items.length, order.items.length, 1)
  return {
    score: matches.reduce((sum, match) => sum + match.score, 0) / denominator,
    productNameScore: matches.reduce((sum, match) => sum + match.productName, 0) / denominator,
    quantityScore: matches.reduce((sum, match) => sum + match.quantity, 0) / denominator,
    lineAmountScore: matches.reduce((sum, match) => sum + match.lineAmount, 0) / denominator,
    lineCoverage: Math.min(invoice.items.length, order.items.length) / denominator,
    matches,
  }
}

function candidate(invoice: Row, order: Row) {
  const dateDifferenceDays = daysBetween(invoice.date, order.date)
  const dateScore = Math.max(0, 1 - Math.abs(dateDifferenceDays) / 75)
  const userAddressScore = Math.max(
    containmentScore(invoice.shippingAddress, order.creatorFullName),
    containmentScore(invoice.shippingAddress, order.source?.userDetails),
  )
  const branchAddressScore = Math.max(
    containmentScore(invoice.shippingAddress, order.branchName),
    containmentScore(invoice.shippingAddress, order.source?.location),
  )
  const addressScore = Math.max(userAddressScore, branchAddressScore, 0.7 * Math.max(
    nameSimilarity(invoice.shippingAddress, order.creatorFullName),
    nameSimilarity(invoice.shippingAddress, order.branchName),
  ))
  const financialScore = Math.max(
    ratioSimilarity(invoice.totalCents, order.subtotalCents),
    ratioSimilarity(invoice.totalCents, order.totalCents),
  )
  const items = itemComparison(invoice, order)
  const score = 0.62 * items.score + 0.17 * addressScore + 0.12 * dateScore + 0.09 * financialScore
  return {
    invoiceNumber: invoice.invoiceNumber,
    tid: order.tid,
    legacyOrderId: order.legacyOrderId,
    databaseOrderId: order.databaseOrderId,
    score,
    dateDifferenceDays,
    dateScore,
    addressScore,
    userAddressScore,
    branchAddressScore,
    financialScore,
    itemScore: items.score,
    productNameScore: items.productNameScore,
    quantityScore: items.quantityScore,
    lineAmountScore: items.lineAmountScore,
    lineCoverage: items.lineCoverage,
    invoiceDate: invoice.date,
    databaseDate: order.date,
    invoiceTotalCents: invoice.totalCents,
    databaseSubtotalCents: order.subtotalCents,
    databaseTotalCents: order.totalCents,
    invoiceLineCount: invoice.lineCount,
    databaseLineCount: order.lineCount,
    invoiceQuantity: invoice.quantity,
    databaseQuantity: order.quantity,
    databaseBranch: order.branchName,
    databaseCreator: order.creatorFullName,
    itemMatches: items.matches.map((match) => ({
      warehouseItem: match.warehouseItem.itemName,
      warehouseQuantity: match.warehouseItem.quantity,
      warehouseLineTotalCents: match.warehouseItem.totalCents,
      databaseItem: match.databaseItem.productName,
      databaseQuantity: match.databaseItem.quantity,
      databaseLineTotalCents: match.databaseItem.subtotalCents,
      score: match.score,
      productNameScore: match.productName,
      quantityScore: match.quantity,
      lineAmountScore: match.lineAmount,
    })),
  }
}

function main() {
  const source = JSON.parse(readFileSync(INPUT, "utf8")) as Row
  const invoices = source.workbook.invoices as Row[]
  const orders = source.database.orders as Row[]
  const candidatesByInvoice = invoices.map((invoice) => {
    const candidates = orders
      .filter((order) => {
        if (Math.abs(daysBetween(invoice.date, order.date)) > 45) return false
        const totalRatio = ratioSimilarity(invoice.totalCents, order.subtotalCents)
        if (totalRatio < 0.5) return false
        const lineRatio = Math.min(invoice.lineCount, order.lineCount) / Math.max(invoice.lineCount, order.lineCount, 1)
        return lineRatio >= 0.4
      })
      .map((order) => candidate(invoice, order))
      .sort((left, right) => right.score - left.score)
      .slice(0, 5)
    return { invoiceNumber: invoice.invoiceNumber, candidates }
  })
  const candidatesByOrder = new Map<string, Row[]>()
  for (const invoice of candidatesByInvoice) {
    for (const candidate of invoice.candidates) {
      const group = candidatesByOrder.get(candidate.tid) ?? []
      group.push(candidate)
      candidatesByOrder.set(candidate.tid, group)
    }
  }
  for (const group of candidatesByOrder.values()) group.sort((left, right) => right.score - left.score)
  const assessment = candidatesByInvoice.map((entry) => {
    const best = entry.candidates[0]
    const second = entry.candidates[1]
    const reciprocal = best ? candidatesByOrder.get(best.tid) ?? [] : []
    return {
      invoiceNumber: entry.invoiceNumber,
      best,
      second,
      margin: best ? best.score - (second?.score ?? 0) : 0,
      reciprocalRank: best ? reciprocal.findIndex((candidate) => candidate.invoiceNumber === entry.invoiceNumber) + 1 : null,
      candidates: entry.candidates,
    }
  })
  const buckets: Record<string, number> = {}
  for (const row of assessment) {
    const bucket = `${Math.floor((row.best?.score ?? 0) * 20) / 20}`
    buckets[bucket] = (buckets[bucket] ?? 0) + 1
  }
  const report = {
    generatedAt: new Date().toISOString(),
    source: INPUT,
    invoices: invoices.length,
    databaseOrders: orders.length,
    scoreBuckets: Object.fromEntries(Object.entries(buckets).sort((a, b) => Number(b[0]) - Number(a[0]))),
    assessment,
  }
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({
    output: OUTPUT,
    invoices: invoices.length,
    databaseOrders: orders.length,
    scoreBuckets: report.scoreBuckets,
    bestScoreAtLeast: {
      "0.90": assessment.filter((row) => (row.best?.score ?? 0) >= 0.9).length,
      "0.85": assessment.filter((row) => (row.best?.score ?? 0) >= 0.85).length,
      "0.80": assessment.filter((row) => (row.best?.score ?? 0) >= 0.8).length,
      "0.75": assessment.filter((row) => (row.best?.score ?? 0) >= 0.75).length,
      "0.70": assessment.filter((row) => (row.best?.score ?? 0) >= 0.7).length,
      "0.65": assessment.filter((row) => (row.best?.score ?? 0) >= 0.65).length,
    },
    reciprocalBest: assessment.filter((row) => row.reciprocalRank === 1).length,
    reciprocalTopTwo: assessment.filter((row) => row.reciprocalRank != null && row.reciprocalRank <= 2).length,
  }, null, 2))
}

main()
