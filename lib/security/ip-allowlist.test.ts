import { describe, expect, it } from "vitest"
import {
  allowlistEntryKey,
  formatAllowlistEntry,
  ipMatchesAllowlist,
  normalizeAllowlistValues,
  parseAllowlistEntry,
  parseIpAddress,
} from "@/lib/security/ip-allowlist"

function entry(value: string) {
  const parsed = parseAllowlistEntry(value)
  if (!parsed) throw new Error(`Expected "${value}" to parse`)
  return parsed
}

describe("parseAllowlistEntry", () => {
  it("accepts a bare IPv4 host as a /32", () => {
    expect(parseAllowlistEntry("203.0.113.7")).toEqual({
      ipAddress: "203.0.113.7",
      prefixLength: 32,
    })
  })

  it("accepts a bare IPv6 host as a /128 in canonical form", () => {
    expect(parseAllowlistEntry("2001:0DB8:0000::0001")).toEqual({
      ipAddress: "2001:db8::1",
      prefixLength: 128,
    })
  })

  it("masks host bits off a CIDR range", () => {
    expect(parseAllowlistEntry("203.0.113.57/24")).toEqual({
      ipAddress: "203.0.113.0",
      prefixLength: 24,
    })
    expect(parseAllowlistEntry("2001:db8:abcd:1234::5/32")).toEqual({
      ipAddress: "2001:db8::",
      prefixLength: 32,
    })
  })

  it("collapses an IPv4-mapped IPv6 address to IPv4", () => {
    expect(parseAllowlistEntry("::ffff:203.0.113.7")).toEqual({
      ipAddress: "203.0.113.7",
      prefixLength: 32,
    })
  })

  it("rebases an IPv4-mapped range onto its IPv4 prefix", () => {
    expect(parseAllowlistEntry("::ffff:203.0.113.0/120")).toEqual({
      ipAddress: "203.0.113.0",
      prefixLength: 24,
    })
  })

  it("rejects a mapped range wider than the mapping itself", () => {
    expect(parseAllowlistEntry("::ffff:203.0.113.0/64")).toBeNull()
  })

  it("preserves the all-zero and full-length IPv6 forms", () => {
    expect(parseAllowlistEntry("::/0")).toEqual({ ipAddress: "::", prefixLength: 0 })
    expect(parseAllowlistEntry("1:2:3:4:5:6:7:8")).toEqual({
      ipAddress: "1:2:3:4:5:6:7:8",
      prefixLength: 128,
    })
  })

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["hostname", "office.example.com"],
    ["octet out of range", "203.0.113.256"],
    ["leading zero octet", "203.0.113.07"],
    ["too few octets", "203.0.113"],
    ["too many octets", "203.0.113.7.1"],
    ["negative prefix", "203.0.113.0/-1"],
    ["ipv4 prefix too long", "203.0.113.0/33"],
    ["ipv6 prefix too long", "2001:db8::/129"],
    ["padded prefix", "203.0.113.0/024"],
    ["empty prefix", "203.0.113.0/"],
    ["double compression", "2001::db8::1"],
    ["oversized group", "2001:db8::12345"],
    ["too few groups", "1:2:3:4:5:6:7"],
    ["too many groups", "1:2:3:4:5:6:7:8:9"],
    ["zone identifier", "fe80::1%eth0"],
    ["wildcard", "203.0.113.*"],
    ["range syntax", "203.0.113.1-203.0.113.9"],
    ["whitespace inside", "203.0. 113.7"],
  ])("rejects %s", (_label, value) => {
    expect(parseAllowlistEntry(value)).toBeNull()
  })

  it("rejects non-string input", () => {
    expect(parseAllowlistEntry(null)).toBeNull()
    expect(parseAllowlistEntry(undefined)).toBeNull()
    expect(parseAllowlistEntry(3232235777)).toBeNull()
    expect(parseAllowlistEntry({ ipAddress: "203.0.113.7" })).toBeNull()
  })

  it("trims surrounding whitespace", () => {
    expect(parseAllowlistEntry("  203.0.113.7  ")).toEqual({
      ipAddress: "203.0.113.7",
      prefixLength: 32,
    })
  })
})

describe("ipMatchesAllowlist", () => {
  it("matches an exact IPv4 host", () => {
    const entries = [entry("203.0.113.7")]
    expect(ipMatchesAllowlist("203.0.113.7", entries)).toBe(true)
    expect(ipMatchesAllowlist("203.0.113.8", entries)).toBe(false)
  })

  it("matches inside an IPv4 CIDR range but not outside it", () => {
    const entries = [entry("203.0.113.0/24")]
    expect(ipMatchesAllowlist("203.0.113.0", entries)).toBe(true)
    expect(ipMatchesAllowlist("203.0.113.255", entries)).toBe(true)
    expect(ipMatchesAllowlist("203.0.114.0", entries)).toBe(false)
    expect(ipMatchesAllowlist("203.0.112.255", entries)).toBe(false)
  })

  it("honours prefixes that fall mid-byte", () => {
    const entries = [entry("10.0.0.0/12")]
    expect(ipMatchesAllowlist("10.0.0.1", entries)).toBe(true)
    expect(ipMatchesAllowlist("10.15.255.254", entries)).toBe(true)
    expect(ipMatchesAllowlist("10.16.0.1", entries)).toBe(false)
    expect(ipMatchesAllowlist("11.0.0.1", entries)).toBe(false)
  })

  it("matches an IPv4-mapped client against an IPv4 entry", () => {
    expect(ipMatchesAllowlist("::ffff:203.0.113.7", [entry("203.0.113.7")])).toBe(true)
    expect(ipMatchesAllowlist("::ffff:203.0.113.9", [entry("203.0.113.0/24")])).toBe(true)
    expect(ipMatchesAllowlist("::ffff:198.51.100.9", [entry("203.0.113.0/24")])).toBe(false)
  })

  it("matches IPv6 ranges", () => {
    const entries = [entry("2001:db8::/32")]
    expect(ipMatchesAllowlist("2001:db8:1234::abcd", entries)).toBe(true)
    expect(ipMatchesAllowlist("2001:db9::1", entries)).toBe(false)
  })

  it("never matches across address families", () => {
    expect(ipMatchesAllowlist("2001:db8::1", [entry("203.0.113.0/24")])).toBe(false)
    expect(ipMatchesAllowlist("203.0.113.7", [entry("2001:db8::/32")])).toBe(false)
  })

  it("matches when any one of several entries matches", () => {
    const entries = [entry("198.51.100.4"), entry("203.0.113.0/24"), entry("2001:db8::/32")]
    expect(ipMatchesAllowlist("203.0.113.99", entries)).toBe(true)
    expect(ipMatchesAllowlist("198.51.100.4", entries)).toBe(true)
    expect(ipMatchesAllowlist("192.0.2.1", entries)).toBe(false)
  })

  it("fails closed on an empty allowlist", () => {
    expect(ipMatchesAllowlist("203.0.113.7", [])).toBe(false)
  })

  it("fails closed on an unknown or malformed client address", () => {
    const entries = [entry("203.0.113.0/24")]
    expect(ipMatchesAllowlist(null, entries)).toBe(false)
    expect(ipMatchesAllowlist(undefined, entries)).toBe(false)
    expect(ipMatchesAllowlist("", entries)).toBe(false)
    expect(ipMatchesAllowlist("unknown", entries)).toBe(false)
    expect(ipMatchesAllowlist("203.0.113.999", entries)).toBe(false)
  })

  it("ignores a stored entry with a corrupt prefix length", () => {
    expect(ipMatchesAllowlist("203.0.113.7", [{ ipAddress: "203.0.113.0", prefixLength: 33 }])).toBe(false)
    expect(ipMatchesAllowlist("203.0.113.7", [{ ipAddress: "203.0.113.0", prefixLength: -1 }])).toBe(false)
    expect(ipMatchesAllowlist("203.0.113.7", [{ ipAddress: "not-an-ip", prefixLength: 32 }])).toBe(false)
  })

  it("treats an explicit /0 as the administrator opening the range", () => {
    expect(ipMatchesAllowlist("198.51.100.1", [entry("0.0.0.0/0")])).toBe(true)
  })
})

describe("normalizeAllowlistValues", () => {
  it("deduplicates equivalent spellings while preserving order", () => {
    const result = normalizeAllowlistValues([
      "203.0.113.7",
      " 203.0.113.7 ",
      "203.0.113.7/32",
      "198.51.100.0/24",
    ])

    expect(result.entries.map(allowlistEntryKey)).toEqual([
      "203.0.113.7/32",
      "198.51.100.0/24",
    ])
    expect(result.invalidValues).toEqual([])
  })

  it("collects every invalid value instead of stopping at the first", () => {
    const result = normalizeAllowlistValues(["203.0.113.7", "nope", "10.0.0.0/64", ""])

    expect(result.entries.map(allowlistEntryKey)).toEqual(["203.0.113.7/32"])
    expect(result.invalidValues).toEqual(["nope", "10.0.0.0/64", ""])
  })
})

describe("formatAllowlistEntry", () => {
  it("hides the prefix for single hosts and keeps it for ranges", () => {
    expect(formatAllowlistEntry(entry("203.0.113.7"))).toBe("203.0.113.7")
    expect(formatAllowlistEntry(entry("2001:db8::1"))).toBe("2001:db8::1")
    expect(formatAllowlistEntry(entry("203.0.113.0/24"))).toBe("203.0.113.0/24")
    expect(formatAllowlistEntry(entry("2001:db8::/32"))).toBe("2001:db8::/32")
  })
})

describe("parseIpAddress", () => {
  it("reports the address family", () => {
    expect(parseIpAddress("203.0.113.7")?.version).toBe(4)
    expect(parseIpAddress("2001:db8::1")?.version).toBe(6)
    expect(parseIpAddress("::ffff:203.0.113.7")?.version).toBe(4)
  })
})
