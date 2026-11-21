// AWS regions Dead by Daylight matchmakes into (same list as the renderer and api2.deadbyqueue.com/regions).
export const REGION_IDS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1',
  'eu-central-1', 'eu-west-1', 'eu-west-2',
  'ap-south-1', 'ap-east-1', 'ap-northeast-1', 'ap-northeast-2',
  'ap-southeast-1', 'ap-southeast-2',
  'sa-east-1',
] as const

export type RegionId = (typeof REGION_IDS)[number]

/** DBD backend services (auth, matchmaking, EAC) live here: blocking it breaks the game. */
export const BACKEND_REGION: RegionId = 'us-east-1'

const REGION_SET: ReadonlySet<string> = new Set(REGION_IDS)

export function isRegionId(value: unknown): value is RegionId {
  return typeof value === 'string' && REGION_SET.has(value)
}

export function isBlockableRegion(value: unknown): value is RegionId {
  return isRegionId(value) && value !== BACKEND_REGION
}
