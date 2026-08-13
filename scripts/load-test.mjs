import { mkdir, writeFile } from "node:fs/promises"
import { randomInt } from "node:crypto"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"

function stripTrailingSlashes(value) {
  let end = value.length
  while (end > 0 && value[end - 1] === "/") end -= 1
  return value.slice(0, end)
}

const targetUrl = stripTrailingSlashes(String(process.env.LOAD_TARGET_URL || "https://oneflowe.apricart.com"))
const branchAdminUsername = String(process.env.LOAD_BA_USERNAME || "").trim()
const orderPortalUsername = String(process.env.LOAD_OP_USERNAME || "").trim()
const password = String(process.env.LOAD_PASSWORD || "")
const validateOnly = process.env.LOAD_VALIDATE_ONLY === "1"
const requestTimeoutMs = positiveInteger(process.env.LOAD_REQUEST_TIMEOUT_MS, 20_000)
const minThinkMs = positiveInteger(process.env.LOAD_MIN_THINK_MS, 500)
const maxThinkMs = Math.max(minThinkMs, positiveInteger(process.env.LOAD_MAX_THINK_MS, 1_500))
const resultsPath = resolve(
  process.env.LOAD_RESULTS_PATH || "LoadTestingReport/current-1000-users/results.json",
)

const defaultStages = [
  { name: "warmup-10", targetVus: 10, rampSeconds: 5, holdSeconds: 10 },
  { name: "load-100", targetVus: 100, rampSeconds: 15, holdSeconds: 20 },
  { name: "load-250", targetVus: 250, rampSeconds: 20, holdSeconds: 20 },
  { name: "load-500", targetVus: 500, rampSeconds: 25, holdSeconds: 20 },
  { name: "load-1000", targetVus: 1_000, rampSeconds: 30, holdSeconds: 30 },
]

const stages = parseStages(process.env.LOAD_STAGES_JSON) || defaultStages

const profiles = {
  branch_admin: [
    { name: "dashboard_page", path: "/dashboard", weight: 8 },
    { name: "session", path: "/api/auth/session", weight: 8 },
    { name: "dashboard_analytics", path: "/api/v1/analytics/dashboard", weight: 18 },
    { name: "orders", path: "/api/v1/orders?page=1&limit=20", weight: 20 },
    { name: "branch_inventory", path: "/api/v1/branch/inventory?page=1&limit=20", weight: 22 },
    { name: "categories", path: "/api/v1/categories?limit=100", weight: 10 },
    { name: "notifications", path: "/api/v1/notifications", weight: 14 },
  ],
  order_portal: [
    { name: "shop_page", path: "/shop", weight: 8 },
    { name: "session", path: "/api/auth/session", weight: 8 },
    {
      name: "visible_inventory",
      path: "/api/v1/branch/inventory?visibility=visible&includeQuantityBudget=true",
      weight: 34,
    },
    { name: "budgets", path: "/api/v1/budgets", weight: 20 },
    { name: "orders", path: "/api/v1/orders?page=1&limit=20", weight: 30 },
  ],
}

class CookieJar {
  constructor() {
    this.values = new Map()
  }

  update(headers) {
    const setCookies = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers.get("set-cookie"))

    for (const setCookie of setCookies) {
      const pair = setCookie.split(";", 1)[0]
      const separator = pair.indexOf("=")
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (value) this.values.set(name, value)
      else this.values.delete(name)
    }
  }

  header() {
    return [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
  }
}

const metrics = {
  startedAt: new Date().toISOString(),
  requests: [],
  activeVus: 0,
  peakVus: 0,
  bytesReceived: 0,
  completedStages: [],
}

let currentPhase = "setup"
let desiredVus = 0
let stopping = false
let nextVuId = 1
const workers = new Map()

function positiveInteger(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseStages(raw) {
  if (!raw) return null
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("LOAD_STAGES_JSON must be a non-empty JSON array")
  }
  return parsed.map((stage, index) => ({
    name: String(stage.name || `stage-${index + 1}`),
    targetVus: positiveInteger(stage.targetVus, 1),
    rampSeconds: positiveInteger(stage.rampSeconds, 1),
    holdSeconds: positiveInteger(stage.holdSeconds, 1),
  }))
}

function splitSetCookieHeader(header) {
  if (!header) return []
  const cookies = []
  let current = ""
  for (const segment of header.split(",")) {
    const trimmed = segment.trimStart()
    const startsCookie = /^[^;=\s]+=[^;,]*/.test(trimmed)
    if (current && startsCookie) {
      cookies.push(current)
      current = trimmed
    } else {
      current += current ? `,${segment}` : segment
    }
  }
  if (current) cookies.push(current)
  return cookies
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function randomInteger(min, max) {
  return min === max ? min : randomInt(min, max + 1)
}

function pickWeighted(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0)
  let cursor = randomInt(totalWeight)
  for (const item of items) {
    if (cursor < item.weight) return item
    cursor -= item.weight
  }
  return items[items.length - 1]
}

async function fetchWithJar(path, jar, init = {}) {
  const headers = new Headers(init.headers || {})
  const cookie = jar.header()
  if (cookie) headers.set("cookie", cookie)
  headers.set("user-agent", "OneFlowe-authorized-load-test/1.0")

  const response = await fetch(`${targetUrl}${path}`, {
    ...init,
    headers,
    redirect: init.redirect || "manual",
    signal: init.signal || AbortSignal.timeout(requestTimeoutMs),
  })
  jar.update(response.headers)
  return response
}

async function login(label, username, expectedRole) {
  if (!username || !password) {
    throw new Error("LOAD_BA_USERNAME, LOAD_OP_USERNAME, and LOAD_PASSWORD are required")
  }

  const jar = new CookieJar()
  const csrfResponse = await fetchWithJar("/api/auth/csrf", jar, {
    headers: { accept: "application/json" },
  })
  if (csrfResponse.status !== 200) {
    throw new Error(`${label} CSRF request returned HTTP ${csrfResponse.status}`)
  }
  const csrfPayload = await csrfResponse.json()
  if (!csrfPayload?.csrfToken) throw new Error(`${label} CSRF token was missing`)

  const form = new URLSearchParams({
    csrfToken: csrfPayload.csrfToken,
    username,
    password,
    callbackUrl: `${targetUrl}/${expectedRole === "ORDER_PORTAL" ? "shop" : "dashboard"}`,
    json: "true",
  })

  const callbackResponse = await fetchWithJar("/api/auth/callback/credentials", jar, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  })

  let callbackPayload = null
  try {
    callbackPayload = await callbackResponse.json()
  } catch {
    // The session request below is the authoritative login check.
  }

  const callbackError = callbackPayload?.url
    ? new URL(callbackPayload.url, targetUrl).searchParams.get("error")
    : callbackPayload?.error
  if (callbackResponse.status >= 400 || callbackError) {
    throw new Error(`${label} login failed (HTTP ${callbackResponse.status}, ${callbackError || "unknown error"})`)
  }

  const sessionResponse = await fetchWithJar("/api/auth/session", jar, {
    headers: { accept: "application/json" },
  })
  const session = await sessionResponse.json().catch(() => null)
  const role = session?.user?.role
  if (sessionResponse.status !== 200 || !session?.user || role !== expectedRole) {
    throw new Error(
      `${label} session validation failed (HTTP ${sessionResponse.status}, role ${role || "missing"})`,
    )
  }

  return { label, role, jar }
}

async function validateProfile(client, endpoints) {
  const checks = []
  for (const endpoint of endpoints) {
    const started = performance.now()
    try {
      const response = await fetchWithJar(endpoint.path, client.jar, {
        headers: { accept: endpoint.path.startsWith("/api/") ? "application/json" : "text/html" },
      })
      const body = await response.arrayBuffer()
      checks.push({
        endpoint: endpoint.name,
        path: endpoint.path,
        status: response.status,
        durationMs: round(performance.now() - started),
        bytes: body.byteLength,
      })
    } catch (error) {
      checks.push({
        endpoint: endpoint.name,
        path: endpoint.path,
        status: 0,
        durationMs: round(performance.now() - started),
        error: safeErrorName(error),
      })
    }
  }
  return checks
}

async function executeRequest(client, endpoint, vuId) {
  const started = performance.now()
  let status = 0
  let bytes = 0
  let error = null

  try {
    const response = await fetchWithJar(endpoint.path, client.jar, {
      headers: { accept: endpoint.path.startsWith("/api/") ? "application/json" : "text/html" },
    })
    status = response.status
    const body = await response.arrayBuffer()
    bytes = body.byteLength
    if (status !== 200) error = `HTTP_${status}`
  } catch (requestError) {
    error = safeErrorName(requestError)
  }

  const durationMs = performance.now() - started
  metrics.bytesReceived += bytes
  metrics.requests.push({
    phase: currentPhase,
    role: client.label,
    endpoint: endpoint.name,
    status,
    durationMs,
    bytes,
    error,
    vuId,
  })
}

async function virtualUser(vuId, clients) {
  metrics.activeVus += 1
  metrics.peakVus = Math.max(metrics.peakVus, metrics.activeVus)
  const client = vuId % 2 === 0 ? clients.order_portal : clients.branch_admin
  const endpoints = profiles[client.label]

  try {
    while (true) {
      if (stopping || vuId > desiredVus) break

      const endpoint = pickWeighted(endpoints)
      await executeRequest(client, endpoint, vuId)
      if (!stopping && vuId <= desiredVus) {
        await sleep(randomInteger(minThinkMs, maxThinkMs))
      }
    }
  } finally {
    metrics.activeVus -= 1
  }
}

function startVu(clients) {
  const vuId = nextVuId++
  const worker = virtualUser(vuId, clients).finally(() => workers.delete(vuId))
  workers.set(vuId, worker)
}

async function rampTo(targetVus, rampSeconds, clients) {
  const startingVus = desiredVus
  desiredVus = targetVus

  if (targetVus <= startingVus) return
  const toStart = targetVus - startingVus
  const steps = Math.min(Math.max(rampSeconds, 1), toStart)
  const intervalMs = (rampSeconds * 1_000) / steps
  let started = 0

  for (let step = 1; step <= steps; step += 1) {
    const targetStarted = Math.round((toStart * step) / steps)
    while (started < targetStarted) {
      startVu(clients)
      started += 1
    }
    if (step < steps) await sleep(intervalMs)
  }
}

function safeErrorName(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "TIMEOUT"
  if (error?.cause?.code) return String(error.cause.code)
  return String(error?.name || "REQUEST_ERROR").replace(/[^A-Z0-9_-]/gi, "_").slice(0, 80)
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits
  return Math.round(value * multiplier) / multiplier
}

function percentile(sorted, value) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

function summarize(requests) {
  const durations = requests.map((request) => request.durationMs).sort((a, b) => a - b)
  const successful = requests.filter((request) => request.status === 200 && !request.error).length
  const statusCounts = {}
  const errorCounts = {}
  for (const request of requests) {
    statusCounts[String(request.status)] = (statusCounts[String(request.status)] || 0) + 1
    if (request.error) errorCounts[request.error] = (errorCounts[request.error] || 0) + 1
  }
  return {
    requests: requests.length,
    successful,
    failed: requests.length - successful,
    errorRatePct: requests.length ? round(((requests.length - successful) / requests.length) * 100) : 0,
    latencyMs: {
      min: durations.length ? round(durations[0]) : 0,
      average: durations.length
        ? round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
        : 0,
      p50: round(percentile(durations, 50)),
      p90: round(percentile(durations, 90)),
      p95: round(percentile(durations, 95)),
      p99: round(percentile(durations, 99)),
      max: durations.length ? round(durations[durations.length - 1]) : 0,
    },
    statusCounts,
    errorCounts,
  }
}

function groupedSummaries(requests, keySelector) {
  const groups = new Map()
  for (const request of requests) {
    const key = keySelector(request)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(request)
  }
  return Object.fromEntries([...groups.entries()].map(([key, values]) => [key, summarize(values)]))
}

function printProgress(stageName, startingRequestCount, startedAt) {
  const recent = metrics.requests.slice(startingRequestCount)
  const summary = summarize(recent)
  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1_000)
  process.stdout.write(
    `[${stageName}] active=${metrics.activeVus} requests=${summary.requests} ` +
    `rps=${round(summary.requests / elapsedSeconds)} p95=${summary.latencyMs.p95}ms ` +
    `errors=${summary.errorRatePct}%\n`,
  )
}

function markdownReport(report) {
  const lines = [
    "# OneFlowe production load-test report",
    "",
    `- Started: ${report.metadata.startedAt}`,
    `- Finished: ${report.metadata.finishedAt}`,
    `- Target: ${report.metadata.targetUrl}`,
    `- Peak concurrent virtual users: ${report.metadata.peakVus}`,
    `- Workload: ${report.metadata.workload}`,
    `- Request timeout: ${report.metadata.requestTimeoutMs} ms`,
    "",
    "## Overall result",
    "",
    `- Verdict: **${report.verdict.pass ? "PASS" : "FAIL"}**`,
    `- Requests: ${report.summary.requests}`,
    `- Completed-request throughput: ${report.summary.requestsPerSecond} requests/second`,
    `- Successful-request throughput: ${report.summary.successfulRequestsPerSecond} requests/second`,
    `- Errors: ${report.summary.failed} (${report.summary.errorRatePct}%)`,
    `- Latency p50 / p95 / p99: ${report.summary.latencyMs.p50} / ${report.summary.latencyMs.p95} / ${report.summary.latencyMs.p99} ms`,
    "",
    "Pass criteria: the test reaches 1,000 VUs, HTTP/request errors remain below 1%, and p95 latency remains below 2,000 ms.",
    "",
    "## Stage results",
    "",
    "| Stage | Target VUs | Requests | Completed RPS | Successful RPS | Errors | p50 | p95 | p99 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ]

  for (const stage of report.stages) {
    lines.push(
      `| ${stage.name} | ${stage.targetVus} | ${stage.summary.requests} | ${stage.requestsPerSecond} | ` +
      `${stage.successfulRequestsPerSecond} | ` +
      `${stage.summary.errorRatePct}% | ${stage.summary.latencyMs.p50} ms | ${stage.summary.latencyMs.p95} ms | ${stage.summary.latencyMs.p99} ms |`,
    )
  }

  lines.push(
    "",
    "## Endpoint results",
    "",
    "| Endpoint | Requests | Errors | Average | p95 | p99 |",
    "|---|---:|---:|---:|---:|---:|",
  )
  for (const [endpoint, summary] of Object.entries(report.endpoints)) {
    lines.push(
      `| ${endpoint} | ${summary.requests} | ${summary.errorRatePct}% | ` +
      `${summary.latencyMs.average} ms | ${summary.latencyMs.p95} ms | ${summary.latencyMs.p99} ms |`,
    )
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- This was a read-only, mixed-role test: 50% branch-admin and 50% order-portal virtual users.",
    "- The two supplied sessions were reused; authentication itself was not multiplied 1,000 times.",
    "- Results include application, database/cache, TLS/network, and single-generator effects.",
    "- No order creation, approval, inventory mutation, or other write endpoint was exercised.",
    "",
  )
  return lines.join("\n")
}

async function main() {
  process.stdout.write(`Target: ${targetUrl}\n`)
  process.stdout.write("Authenticating one session for each role...\n")
  const [branchAdmin, orderPortal] = await Promise.all([
    login("branch_admin", branchAdminUsername, "BRANCH_ADMIN"),
    login("order_portal", orderPortalUsername, "ORDER_PORTAL"),
  ])
  const clients = { branch_admin: branchAdmin, order_portal: orderPortal }
  process.stdout.write("Authentication succeeded for BRANCH_ADMIN and ORDER_PORTAL.\n")

  process.stdout.write("Validating every read-only workload endpoint...\n")
  const validation = {
    branch_admin: await validateProfile(branchAdmin, profiles.branch_admin),
    order_portal: await validateProfile(orderPortal, profiles.order_portal),
  }
  for (const [role, checks] of Object.entries(validation)) {
    for (const check of checks) {
      process.stdout.write(
        `[validate] role=${role} endpoint=${check.endpoint} status=${check.status} duration=${check.durationMs}ms\n`,
      )
    }
  }
  const invalidChecks = Object.values(validation).flat().filter((check) => check.status !== 200)
  if (invalidChecks.length > 0) {
    throw new Error(`Workload validation failed for ${invalidChecks.length} endpoint(s); load was not started`)
  }

  if (validateOnly) {
    process.stdout.write("Validation-only run completed successfully.\n")
    return
  }

  const testStarted = performance.now()
  const progressTimer = setInterval(() => {
    printProgress(currentPhase, 0, testStarted)
  }, 10_000)
  progressTimer.unref()

  try {
    for (const stage of stages) {
      currentPhase = stage.name
      const stageStarted = performance.now()
      const startingRequestCount = metrics.requests.length
      process.stdout.write(
        `Starting ${stage.name}: ramp to ${stage.targetVus} VUs over ${stage.rampSeconds}s, ` +
        `then hold ${stage.holdSeconds}s.\n`,
      )
      await rampTo(stage.targetVus, stage.rampSeconds, clients)
      await sleep(stage.holdSeconds * 1_000)
      const stageEnded = performance.now()
      const stageRequests = metrics.requests.slice(startingRequestCount)
      const stageSummary = summarize(stageRequests)
      metrics.completedStages.push({
        ...stage,
        elapsedSeconds: round((stageEnded - stageStarted) / 1_000),
        requestsPerSecond: round(stageRequests.length / ((stageEnded - stageStarted) / 1_000)),
        successfulRequestsPerSecond: round(
          stageSummary.successful / ((stageEnded - stageStarted) / 1_000),
        ),
        summary: stageSummary,
      })
      printProgress(stage.name, startingRequestCount, stageStarted)
    }
  } finally {
    clearInterval(progressTimer)
    currentPhase = "cooldown"
    stopping = true
    desiredVus = 0
    await Promise.allSettled(workers.values())
  }

  const testEnded = performance.now()
  const overall = summarize(metrics.requests)
  const elapsedSeconds = (testEnded - testStarted) / 1_000
  const summary = {
    ...overall,
    elapsedSeconds: round(elapsedSeconds),
    requestsPerSecond: round(overall.requests / elapsedSeconds),
    successfulRequestsPerSecond: round(overall.successful / elapsedSeconds),
    megabytesReceived: round(metrics.bytesReceived / 1024 / 1024),
  }
  const pass = metrics.peakVus >= 1_000 && summary.errorRatePct < 1 && summary.latencyMs.p95 < 2_000
  const report = {
    metadata: {
      startedAt: metrics.startedAt,
      finishedAt: new Date().toISOString(),
      targetUrl,
      requestedPeakVus: Math.max(...stages.map((stage) => stage.targetVus)),
      peakVus: metrics.peakVus,
      workload: "50% BRANCH_ADMIN, 50% ORDER_PORTAL; read-only user journeys",
      requestTimeoutMs,
      thinkTimeMs: { min: minThinkMs, max: maxThinkMs },
      generator: `${process.platform} ${process.arch}; Node ${process.version}`,
    },
    verdict: {
      pass,
      criteria: { minimumPeakVus: 1_000, maximumErrorRatePct: 1, maximumP95LatencyMs: 2_000 },
    },
    validation,
    summary,
    stages: metrics.completedStages,
    roles: groupedSummaries(metrics.requests, (request) => request.role),
    endpoints: groupedSummaries(metrics.requests, (request) => `${request.role}/${request.endpoint}`),
    phases: groupedSummaries(metrics.requests, (request) => request.phase),
  }

  await mkdir(dirname(resultsPath), { recursive: true })
  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  const markdownPath = resultsPath.replace(/\.json$/i, ".md")
  await writeFile(markdownPath, markdownReport(report), "utf8")
  process.stdout.write(`Results written to ${resultsPath}\n`)
  process.stdout.write(
    `Result: ${pass ? "PASS" : "FAIL"}; peak=${metrics.peakVus} VUs, ` +
    `requests=${summary.requests}, rps=${summary.requestsPerSecond}, ` +
    `errors=${summary.errorRatePct}%, p95=${summary.latencyMs.p95}ms.\n`,
  )
}

try {
  await main()
} catch (error) {
  stopping = true
  desiredVus = 0
  process.stderr.write(`Load test failed: ${safeErrorName(error)}: ${String(error?.message || error)}\n`)
  process.exitCode = 1
}
