// Pure parsing of https://ip-ranges.amazonaws.com/ip-ranges.json (unit-tested).
import { collapseCidrs } from './cidr'

export interface AwsIpRanges {
  syncToken: string
  createDate: string
  prefixes: Array<{ ip_prefix: string; region: string; service: string; network_border_group?: string }>
  ipv6_prefixes?: Array<{ ipv6_prefix: string; region: string; service: string; network_border_group?: string }>
}

/**
 * GameLift fleets (DBD dedicated servers and the gamelift-ping.<region>.api.aws latency beacons)
 * run on EC2 addresses. Local Zones / Wavelength border groups of the region are included on purpose:
 * GameLift can place fleets there and they still report the parent region.
 */
export const GAME_SERVER_SERVICES: ReadonlySet<string> = new Set(['EC2'])

export function validateAwsRanges(data: unknown): AwsIpRanges {
  const d = data as Partial<AwsIpRanges> | null
  if (!d || typeof d !== 'object' || !Array.isArray(d.prefixes) || d.prefixes.length === 0) {
    throw new Error('AWS IP ranges payload is invalid')
  }
  if (d.ipv6_prefixes !== undefined && !Array.isArray(d.ipv6_prefixes)) {
    throw new Error('AWS IP ranges payload is invalid (ipv6_prefixes)')
  }
  return {
    syncToken: String(d.syncToken ?? ''),
    createDate: String(d.createDate ?? ''),
    prefixes: d.prefixes,
    ipv6_prefixes: d.ipv6_prefixes ?? [],
  }
}

/** All EC2 ranges (IPv4 then IPv6) of a region, normalized and collapsed. */
export function extractRegionRanges(data: AwsIpRanges, regionId: string): string[] {
  const out: string[] = []
  for (const p of data.prefixes) {
    if (p.region === regionId && GAME_SERVER_SERVICES.has(p.service) && p.ip_prefix) out.push(p.ip_prefix)
  }
  for (const p of data.ipv6_prefixes ?? []) {
    if (p.region === regionId && GAME_SERVER_SERVICES.has(p.service) && p.ipv6_prefix) out.push(p.ipv6_prefix)
  }
  return collapseCidrs(out)
}

/**
 * EC2 ranges published with region "GLOBAL": not tied to one region. GameLift Player Gateway relays
 * (DDoS protection, 2026) show up there: the game talks to a relay, the real server region is hidden.
 */
export function extractGlobalEc2Ranges(data: AwsIpRanges): string[] {
  return extractRegionRanges(data, 'GLOBAL')
}

export function extractAllRegions(data: AwsIpRanges, regionIds: readonly string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const id of regionIds) result[id] = extractRegionRanges(data, id)
  return result
}

export function countFamilies(cidrs: readonly string[]): { v4: number; v6: number } {
  let v6 = 0
  for (const c of cidrs) if (c.includes(':')) v6++
  return { v4: cidrs.length - v6, v6 }
}
