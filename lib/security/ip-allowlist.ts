/**
 * IPv4/IPv6 allowlist parsing and matching for tenant private-network login.
 *
 * Deliberately free of Node built-ins so one implementation validates admin
 * input in the browser, in the API route, and in the authentication callbacks.
 * A second parser would risk the UI accepting an entry the server interprets
 * differently, which for an access-control list is a security defect.
 *
 * Entries are stored already masked to their network address, so matching is a
 * pure prefix comparison and an entry can never carry ambiguous host bits.
 */

export type AllowlistEntry = {
  ipAddress: string
  prefixLength: number
}

type IpVersion = 4 | 6

type ParsedIp = {
  version: IpVersion
  bytes: Uint8Array
}

export const IPV4_PREFIX_BITS = 32
export const IPV6_PREFIX_BITS = 128

// Generous enough that no real corporate network hits it, while keeping a
// single request's parsing and storage cost bounded.
export const MAX_ALLOWLIST_ENTRIES = 1000

const IPV6_GROUP_COUNT = 8
const IPV6_BYTE_LENGTH = 16
const IPV4_BYTE_LENGTH = 4
const IPV4_MAPPED_PREFIX_BITS = 96

function maxPrefixBits(version: IpVersion): number {
  return version === 4 ? IPV4_PREFIX_BITS : IPV6_PREFIX_BITS
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".")
  if (parts.length !== IPV4_BYTE_LENGTH) return null

  const bytes = new Uint8Array(IPV4_BYTE_LENGTH)
  for (let index = 0; index < IPV4_BYTE_LENGTH; index++) {
    const part = parts[index]
    // Leading zeros are rejected outright: some resolvers read them as octal,
    // so accepting them would let one written entry mean two addresses.
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part.startsWith("0")) return null

    const octet = Number(part)
    if (octet > 255) return null
    bytes[index] = octet
  }
  return bytes
}

function parseIpv6Groups(parts: string[]): number[] | null {
  const groups: number[] = []

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]

    // Only the final group may carry the dotted-quad form, e.g. ::ffff:1.2.3.4
    if (index === parts.length - 1 && part.includes(".")) {
      const embedded = parseIpv4(part)
      if (!embedded) return null
      groups.push((embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3])
      continue
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    groups.push(Number.parseInt(part, 16))
  }

  return groups
}

function groupsToBytes(groups: number[]): Uint8Array {
  const bytes = new Uint8Array(IPV6_BYTE_LENGTH)
  for (let index = 0; index < IPV6_GROUP_COUNT; index++) {
    bytes[index * 2] = (groups[index] >> 8) & 0xff
    bytes[index * 2 + 1] = groups[index] & 0xff
  }
  return bytes
}

function parseIpv6(value: string): Uint8Array | null {
  if (value.includes("%")) return null

  const compressedSections = value.split("::")
  if (compressedSections.length > 2) return null

  const isCompressed = compressedSections.length === 2
  const leftText = compressedSections[0]
  const rightText = isCompressed ? compressedSections[1] : ""

  const leftGroups = leftText ? parseIpv6Groups(leftText.split(":")) : []
  const rightGroups = rightText ? parseIpv6Groups(rightText.split(":")) : []
  if (!leftGroups || !rightGroups) return null

  if (!isCompressed) {
    if (leftGroups.length !== IPV6_GROUP_COUNT) return null
    return groupsToBytes(leftGroups)
  }

  // "::" must stand for at least one omitted group, otherwise the address
  // would be writable in two different ways.
  const omitted = IPV6_GROUP_COUNT - leftGroups.length - rightGroups.length
  if (omitted < 1) return null

  return groupsToBytes([
    ...leftGroups,
    ...new Array<number>(omitted).fill(0),
    ...rightGroups,
  ])
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let index = 0; index < 10; index++) {
    if (bytes[index] !== 0) return false
  }
  return bytes[10] === 0xff && bytes[11] === 0xff
}

/**
 * Parse a bare address. IPv4-mapped IPv6 (`::ffff:203.0.113.7`) collapses to
 * its IPv4 form so a client arriving over a dual-stack proxy still matches the
 * IPv4 entry an administrator typed.
 */
export function parseIpAddress(value: unknown): ParsedIp | null {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (!trimmed) return null

  if (trimmed.includes(":")) {
    const bytes = parseIpv6(trimmed)
    if (!bytes) return null
    return isIpv4Mapped(bytes)
      ? { version: 4, bytes: bytes.slice(12) }
      : { version: 6, bytes }
  }

  const bytes = parseIpv4(trimmed)
  return bytes ? { version: 4, bytes } : null
}

function formatIpv4(bytes: Uint8Array): string {
  return Array.from(bytes).join(".")
}

/**
 * RFC 5952 canonical text: lowercase, no leading zeros, and the longest run of
 * zero groups compressed. Canonical output keeps the stored uniqueness
 * constraint meaningful — one network cannot be stored under two spellings.
 */
function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = []
  for (let index = 0; index < IPV6_GROUP_COUNT; index++) {
    groups.push((bytes[index * 2] << 8) | bytes[index * 2 + 1])
  }

  let bestStart = -1
  let bestLength = 0
  let runStart = -1
  for (let index = 0; index < groups.length; index++) {
    if (groups[index] !== 0) {
      runStart = -1
      continue
    }
    if (runStart === -1) runStart = index
    const runLength = index - runStart + 1
    if (runLength > bestLength) {
      bestLength = runLength
      bestStart = runStart
    }
  }

  const text = groups.map((group) => group.toString(16))
  if (bestLength < 2) return text.join(":")

  const head = text.slice(0, bestStart).join(":")
  const tail = text.slice(bestStart + bestLength).join(":")
  return `${head}::${tail}`
}

function formatIp(version: IpVersion, bytes: Uint8Array): string {
  return version === 4 ? formatIpv4(bytes) : formatIpv6(bytes)
}

function maskToPrefix(bytes: Uint8Array, prefixLength: number): Uint8Array {
  const masked = new Uint8Array(bytes)
  const fullBytes = prefixLength >> 3
  const remainingBits = prefixLength & 7

  if (remainingBits > 0) {
    masked[fullBytes] &= (0xff << (8 - remainingBits)) & 0xff
  }
  for (let index = fullBytes + (remainingBits > 0 ? 1 : 0); index < masked.length; index++) {
    masked[index] = 0
  }
  return masked
}

function parsePrefixLength(value: string, version: IpVersion): number | null {
  if (!/^\d{1,3}$/.test(value)) return null
  if (value.length > 1 && value.startsWith("0")) return null

  const prefixLength = Number(value)
  return prefixLength <= maxPrefixBits(version) ? prefixLength : null
}

/**
 * Rebase an IPv4-mapped IPv6 range onto IPv4, e.g. `::ffff:203.0.113.0/120`
 * describes exactly `203.0.113.0/24`. A prefix shorter than the mapping itself
 * would also cover non-mapped space, so it is rejected rather than guessed at.
 */
function rebaseMappedPrefix(prefixLength: number): number | null {
  return prefixLength >= IPV4_MAPPED_PREFIX_BITS
    ? prefixLength - IPV4_MAPPED_PREFIX_BITS
    : null
}

/**
 * Parse one administrator-supplied entry: a bare address (`203.0.113.7`,
 * `2001:db8::1`) or a CIDR range (`203.0.113.0/24`, `2001:db8::/32`).
 * Returns null for anything unparseable — callers must treat null as a
 * rejected entry and never as "allow".
 */
export function parseAllowlistEntry(raw: unknown): AllowlistEntry | null {
  if (typeof raw !== "string") return null

  const trimmed = raw.trim()
  if (!trimmed) return null

  const separatorIndex = trimmed.indexOf("/")
  const addressText = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex)
  const prefixText = separatorIndex === -1 ? null : trimmed.slice(separatorIndex + 1)

  // Parse without collapsing the mapped form first, so an explicit IPv6 prefix
  // is interpreted in the family it was written in.
  const isIpv6Text = addressText.includes(":")
  const bytes = isIpv6Text ? parseIpv6(addressText.trim()) : parseIpv4(addressText.trim())
  if (!bytes) return null

  const writtenVersion: IpVersion = isIpv6Text ? 6 : 4
  const writtenPrefix = prefixText === null
    ? maxPrefixBits(writtenVersion)
    : parsePrefixLength(prefixText.trim(), writtenVersion)
  if (writtenPrefix === null) return null

  if (writtenVersion === 6 && isIpv4Mapped(bytes)) {
    const rebased = rebaseMappedPrefix(writtenPrefix)
    if (rebased === null) return null
    return {
      ipAddress: formatIpv4(maskToPrefix(bytes.slice(12), rebased)),
      prefixLength: rebased,
    }
  }

  return {
    ipAddress: formatIp(writtenVersion, maskToPrefix(bytes, writtenPrefix)),
    prefixLength: writtenPrefix,
  }
}

/** Stable identity for deduplication and for the stored uniqueness constraint. */
export function allowlistEntryKey(entry: AllowlistEntry): string {
  return `${entry.ipAddress}/${entry.prefixLength}`
}

/** Display form: a single host shows as a plain address, a range keeps its /N. */
export function formatAllowlistEntry(entry: AllowlistEntry): string {
  const parsed = parseIpAddress(entry.ipAddress)
  if (parsed && entry.prefixLength === maxPrefixBits(parsed.version)) {
    return entry.ipAddress
  }
  return allowlistEntryKey(entry)
}

function sharesPrefix(left: Uint8Array, right: Uint8Array, prefixLength: number): boolean {
  const fullBytes = prefixLength >> 3
  for (let index = 0; index < fullBytes; index++) {
    if (left[index] !== right[index]) return false
  }

  const remainingBits = prefixLength & 7
  if (remainingBits === 0) return true

  const mask = (0xff << (8 - remainingBits)) & 0xff
  return (left[fullBytes] & mask) === (right[fullBytes] & mask)
}

/**
 * Whether a client address falls inside any allowlist entry.
 *
 * Fails closed: an unknown, unparseable, or empty client address never matches,
 * and an empty allowlist never matches.
 */
export function ipMatchesAllowlist(
  clientIp: unknown,
  entries: readonly AllowlistEntry[],
): boolean {
  if (entries.length === 0) return false

  const client = parseIpAddress(clientIp)
  if (!client) return false

  return entries.some((entry) => {
    const network = parseIpAddress(entry.ipAddress)
    if (!network || network.version !== client.version) return false
    if (
      !Number.isInteger(entry.prefixLength) ||
      entry.prefixLength < 0 ||
      entry.prefixLength > maxPrefixBits(network.version)
    ) {
      return false
    }
    return sharesPrefix(client.bytes, network.bytes, entry.prefixLength)
  })
}

export type AllowlistNormalizationResult = {
  entries: AllowlistEntry[]
  invalidValues: string[]
}

/**
 * Parse and deduplicate a whole submitted list, preserving input order and
 * reporting every rejected value so the administrator can correct all of them
 * in one pass rather than one error at a time.
 */
export function normalizeAllowlistValues(values: readonly unknown[]): AllowlistNormalizationResult {
  const entries: AllowlistEntry[] = []
  const invalidValues: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    const parsed = parseAllowlistEntry(value)
    if (!parsed) {
      invalidValues.push(typeof value === "string" ? value.trim() : String(value))
      continue
    }

    const key = allowlistEntryKey(parsed)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(parsed)
  }

  return { entries, invalidValues }
}
