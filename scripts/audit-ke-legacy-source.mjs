import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const BASE_URL = "https://logistics.oneflowe.com/"
const OUTPUT_DIR = path.resolve("updatedReports")
const RUN_DATE = new Date().toISOString().slice(0, 10)

function absoluteUrl(value) {
  return new URL(value, BASE_URL).toString()
}

async function request(url, options = {}) {
  const response = await fetch(absoluteUrl(url), {
    redirect: "follow",
    ...options,
    headers: {
      Accept: "application/json, text/plain, */*",
      ...options.headers,
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${new URL(url, BASE_URL).pathname} returned ${response.status}: ${text.slice(0, 240)}`)
  }
  return { response, text }
}

function unique(values) {
  return [...new Set(values)]
}

function matchAll(source, expression, index = 1) {
  return [...source.matchAll(expression)].map((match) => match[index]).filter(Boolean)
}

function extractBalancedObject(source, start) {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      continue
    }
    if (character === "{") depth += 1
    if (character === "}") {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return ""
}

function parseStates(source) {
  const states = []
  const expression = /\.state\(\s*["']([^"']+)["']\s*,\s*\{/g
  for (const match of source.matchAll(expression)) {
    const objectStart = match.index + match[0].lastIndexOf("{")
    const block = extractBalancedObject(source, objectStart)
    const value = (name) => block.match(new RegExp(String.raw`${name}\s*:\s*["']([^"']+)["']`))?.[1] || null
    states.push({
      state: match[1],
      url: value("url"),
      controller: value("controller"),
      templateUrl: value("templateUrl"),
      abstract: /abstract\s*:\s*true/.test(block),
    })
  }
  return states
}

function parseHttpCalls(source, script) {
  const calls = []
  const expression = /\$http\.(get|post|put|patch|delete)\s*\(([^\n;]{1,500})/gi
  for (const match of source.matchAll(expression)) {
    const argument = match[2].replace(/\s+/g, " ").trim()
    calls.push({ script, method: match[1].toUpperCase(), expression: argument })
  }
  return calls
}

function parseTemplate(templateUrl, source) {
  const strip = (value) => value.replace(/<[^>]+>/g, " ").replaceAll("&nbsp;", " ").replace(/\s+/g, " ").trim()
  return {
    templateUrl,
    titleCandidates: unique([
      ...matchAll(source, /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi).map(strip),
      ...matchAll(source, /<label[^>]*>([\s\S]*?)<\/label>/gi).map(strip),
    ]).filter(Boolean).slice(0, 80),
    tableHeaders: unique(matchAll(source, /<th[^>]*>([\s\S]*?)<\/th>/gi).map(strip)).filter(Boolean),
    modelBindings: unique(matchAll(source, /ng-model\s*=\s*["']([^"']+)["']/gi)),
    repeatedCollections: unique(matchAll(source, /ng-repeat\s*=\s*["'][^"']+\s+in\s+([^"'\s|]+)/gi)),
    bytes: Buffer.byteLength(source),
  }
}

function sanitizeUser(row) {
  if (!row || typeof row !== "object") return null
  const allow = [
    "ID", "SubUserID", "FirstName", "LastName", "Company", "BusinessType", "RoleID",
    "UserType", "Country", "CountryID", "CityID", "StatusID", "IsActivate", "PackageName",
    "BranchLimit", "DaysRemaining", "BusinessKey", "CreatedOn", "DateFrom", "DateTo",
  ]
  return Object.fromEntries(allow.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]))
}

async function authenticate() {
  const email = process.env.LEGACY_AUDIT_EMAIL
  const password = process.env.LEGACY_AUDIT_PASSWORD
  if (!email || !password) return { attempted: false }

  const loginPath = `api/Login/${encodeURIComponent(email)}/${encodeURIComponent(password)}`
  const login = JSON.parse((await request(loginPath)).text)
  if (!login?.Success) throw new Error(`Legacy login failed: ${login?.Message || "unknown error"}`)

  const verifyPath = `api/Login/VerifyUser/${encodeURIComponent(email)}/null`
  const verified = JSON.parse((await request(verifyPath, { method: "POST" })).text)
  const rows = Array.isArray(verified) ? verified : verified ? [verified] : []
  return {
    attempted: true,
    success: rows.length > 0,
    message: login.Message || null,
    isMultifactor: login.Data?.isMultifactor ?? null,
    responseFields: rows[0] ? Object.keys(rows[0]) : [],
    sensitiveFieldsReturned: rows[0]
      ? Object.keys(rows[0]).filter((key) => /password|email|contact|address|token|key/i.test(key))
      : [],
    user: sanitizeUser(rows[0]),
  }
}

async function main() {
  const root = (await request("/")).text
  const scriptPaths = unique(matchAll(root, /<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/gi))
    .filter((value) => new URL(value, BASE_URL).origin === new URL(BASE_URL).origin)

  const sources = new Map()
  const scriptInventory = []
  for (const scriptPath of scriptPaths) {
    const { text } = await request(scriptPath)
    sources.set(new URL(scriptPath, BASE_URL).pathname, text)
    scriptInventory.push({ path: new URL(scriptPath, BASE_URL).pathname, bytes: Buffer.byteLength(text) })
  }

  const appSource = sources.get("/Scripts/app.js") || (await request("/Scripts/app.js?v=20.3")).text
  const states = parseStates(appSource)
  const templatePaths = unique(states.map((state) => state.templateUrl).filter(Boolean))
  const templates = []
  const templateErrors = []
  for (const templatePath of templatePaths) {
    try {
      const { text } = await request(templatePath)
      templates.push(parseTemplate(templatePath, text))
    } catch (error) {
      templateErrors.push({ templateUrl: templatePath, error: error.message })
    }
  }

  const httpCalls = []
  for (const [script, source] of sources) httpCalls.push(...parseHttpCalls(source, script))
  if (!sources.has("/Scripts/app.js")) httpCalls.push(...parseHttpCalls(appSource, "/Scripts/app.js"))

  const auth = await authenticate()
  const report = {
    generatedAt: new Date().toISOString(),
    source: BASE_URL,
    safety: {
      mode: "read-only static inspection plus login verification",
      operationalGetRequestsIssued: false,
      prohibitedMethods: ["PUT", "PATCH", "DELETE"],
      note: "No application UI was loaded after authentication because its initialization code invokes a monthly-budget update POST.",
    },
    auth,
    inventory: {
      scripts: scriptInventory,
      states,
      templates,
      templateErrors,
      httpCalls,
      summary: {
        firstPartyScripts: scriptInventory.length,
        states: states.length,
        concretePages: states.filter((state) => state.templateUrl).length,
        templatesFetched: templates.length,
        httpCallsByMethod: Object.fromEntries(
          ["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => [method, httpCalls.filter((call) => call.method === method).length]),
        ),
      },
    },
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  const output = path.join(OUTPUT_DIR, `ke-legacy-source-static-audit-${RUN_DATE}.json`)
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log({ output, auth: report.auth, summary: report.inventory.summary })
}

try {
  await main()
} catch (error) {
  console.error(error.stack || error.message)
  process.exitCode = 1
}
