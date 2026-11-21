// Amazon GameLift relays (DDoS protection, 2026): matches go through relay IPs published as "GLOBAL",
// which hide the server region. relay-locations.json (tools/generate-relay-locations.mjs) estimates the
// region of each relay block from public routing + geolocation data. Relays sit next to the game servers,
// so blocking the relays of a region stops relayed matches there, like blocking its servers used to.
import relayLocations from './relay-locations.json'
import { CidrMatcher, collapseCidrs } from './cidr'

const table = (relayLocations as { blocks: Record<string, string> }).blocks

const blocksByRegion: Record<string, string[]> = {}
const matcher = new CidrMatcher()
for (const [block, region] of Object.entries(table)) {
  ;(blocksByRegion[region] ??= []).push(block)
  matcher.add(region, [block])
}

/** Region of a relay IP, estimated. null when the IP is not a located relay block. */
export function estimateRelayRegion(ip: string): string | null {
  return matcher.match(ip)
}

/** Located relay blocks of a region. */
export function getRelayBlocks(regionId: string): string[] {
  return [...(blocksByRegion[regionId] ?? [])]
}

/** Everything a region block covers: its EC2 ranges, plus its relays when enabled. */
export function regionBlockList(regionRanges: readonly string[], relayBlocks: readonly string[], includeRelays: boolean): string[] {
  if (regionRanges.length === 0) return []
  return collapseCidrs(includeRelays ? [...regionRanges, ...relayBlocks] : regionRanges)
}
