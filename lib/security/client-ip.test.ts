import { describe, expect, it } from "vitest"

import {
  parseIpAddress,
  resolveTrustedClientIp,
} from "@/lib/security/client-ip"

describe("trusted client IP resolution", () => {
  it("accepts valid addresses and rejects malformed forwarding values", () => {
    expect(parseIpAddress("203.0.113.4:443")).toBe("203.0.113.4")
    expect(parseIpAddress("[2001:db8::1]:443")).toBe("2001:db8::1")
    expect(parseIpAddress("999.1.1.1")).toBeNull()
    expect(parseIpAddress("attacker.example")).toBeNull()
  })

  it("prefers the CloudFront viewer address over spoofable forwarding input", () => {
    expect(resolveTrustedClientIp({
      cloudFrontViewerAddress: "198.51.100.20:443",
      forwardedFor: "1.2.3.4, 203.0.113.9",
      realIp: "192.0.2.5",
      trustedProxyHops: 1,
    })).toBe("198.51.100.20")
  })

  it("selects from the trusted side of the forwarding chain", () => {
    expect(resolveTrustedClientIp({
      cloudFrontViewerAddress: null,
      forwardedFor: "1.2.3.4, 203.0.113.9",
      realIp: null,
      trustedProxyHops: 1,
    })).toBe("203.0.113.9")
  })
})
