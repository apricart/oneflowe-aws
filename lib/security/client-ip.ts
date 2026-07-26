import { isIP } from "node:net"

export function parseIpAddress(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (isIP(trimmed)) return trimmed

  const bracketedIpv6 = trimmed.match(/^\[([0-9a-f:]+)\](?::\d+)?$/i)
  if (bracketedIpv6 && isIP(bracketedIpv6[1])) return bracketedIpv6[1]

  const ipv4WithPort = trimmed.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/)
  if (ipv4WithPort && isIP(ipv4WithPort[1])) return ipv4WithPort[1]

  return null
}

export function resolveTrustedClientIp(input: {
  cloudFrontViewerAddress: string | null
  forwardedFor: string | null
  realIp: string | null
  trustedProxyHops: number
}): string {
  const cloudFrontIp = parseIpAddress(input.cloudFrontViewerAddress)
  if (cloudFrontIp) return cloudFrontIp

  if (input.forwardedFor) {
    const ips = input.forwardedFor
      .split(",")
      .map((value) => parseIpAddress(value))
      .filter((value): value is string => Boolean(value))
    const trustedProxyHops = Math.max(1, Math.trunc(input.trustedProxyHops))
    const clientIndex = ips.length - trustedProxyHops
    if (clientIndex >= 0) return ips[clientIndex]
  }

  return parseIpAddress(input.realIp) || "unknown"
}
