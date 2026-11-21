export interface Region {
  id: string
  name: string
  country: string
  continent: string
  flag: string
  countryCode: string
  lat: number
  lng: number
  timezone: string
}

export type RegionStatus = 'active' | 'blocked' | 'loading' | 'error'

export interface RegionState extends Region {
  status: RegionStatus
  cidrCount: number
  error?: string
  pingMs?: number | null
  pingIp?: string
  pingLoading?: boolean
}

export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'step'

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  message: string
}

export interface InitStep {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
  detail?: string
}

export interface ExeValidationResult {
  ok: boolean
  error?: string
  warning?: string
}

export interface ActionResult {
  ok: boolean
  error?: string
  code?: string
}

export interface PingResult {
  ok: boolean
  ip: string | null
  ms: number | null
  error?: string
}

export interface TrackerCandidate {
  ip: string
  port: number
  score: number
  lastSeen: number
  count: number
  regionId: string | null
  /** regionId is an estimate (AWS relay located from public data). */
  estimated?: boolean
}

export interface TrackerResult {
  dbdRunning: boolean
  current_server: string | null
  currentIp: string | null
  currentRegion: string | null
  /** The game is connected to a server inside a region that is currently blocked. */
  blockedRegionHit: boolean
  /** The game talks to an AWS GameLift relay: the real server region is hidden. */
  viaRelay: boolean
  /** Region of the relay, estimated from public geolocation data. */
  estimatedRegion: string | null
  /** Regions whose GameLift ping beacon the game contacted recently (matchmaking latency checks). */
  pingedRegions: Array<{ region: string; blocked: boolean }>
  confidence: number
  candidates: TrackerCandidate[]
  udpPorts: number[]
  dbdPid: number
  exitlagRunning: boolean
}

export type ActiveConnectionsResult = TrackerResult

export interface RegionProof {
  count: number
  /** Attempts aimed at an AWS relay of the region: a match there was prevented. */
  relayCount: number
  lastAt: string
  lastRemote: string
}

/** Dead by Daylight connection attempts dropped by the filters (WFP net events), per region. */
export interface BlockProof {
  available: boolean
  regions: Record<string, RegionProof>
  total: number
}

export interface RefreshIpsResult {
  added: number
  removed: number
  /** Blocked regions whose filters were rebuilt because AWS ranges changed. */
  resynced: string[]
}

export interface UpdateInfo {
  available: boolean
  version: string
  url: string
}

export interface ServerInfo {
  online: boolean
  killerQueue: string | null
  survivorQueue: string | null
}

export type ServerStatusMap = Record<string, ServerInfo>

export interface ServerStatusResult {
  ok: boolean
  data: ServerStatusMap
}

export interface FirewallHealthResult {
  ok: boolean
  details: string[]
  error?: string
}

export interface AutoDetectResult {
  found: boolean
  path?: string
  error?: string
}

export interface ElectronAPI {
  win: {
    minimize:    () => void
    maximize:    () => void
    close:       () => void
    isMaximized: () => Promise<boolean>
  }
  blockRegion:   (regionId: string) => Promise<ActionResult>
  unblockRegion: (regionId: string) => Promise<ActionResult>
  unblockAll:    () => Promise<ActionResult>
  getStatus:     () => Promise<Record<string, boolean>>
  getCidrCounts: () => Promise<Record<string, number>>
  refreshIps:    () => Promise<RefreshIpsResult>
  isAdmin:       () => Promise<boolean>
  checkExePath:  () => Promise<ExeValidationResult>
  getExePath:  () => Promise<string>
  setExePath:  (path: string) => Promise<ExeValidationResult>
  browseExe:   () => Promise<string | null>
  autoDetectExe: () => Promise<AutoDetectResult>
  getAppVersion: () => Promise<string>
  getPermanentRegions: () => Promise<string[]>
  markPermanent:       (regionId: string) => Promise<void>
  unmarkPermanent:     (regionId: string) => Promise<void>
  sendBlockedCount: (count: number) => void
  pingRegion: (regionId: string) => Promise<PingResult>
  getActiveConnections: () => Promise<TrackerResult>
  getTrackerStatus:     () => Promise<{ running: boolean; result: TrackerResult }>
  getBlockProof:        () => Promise<BlockProof>
  getBlockRelays:       () => Promise<boolean>
  setBlockRelays:       (enabled: boolean) => Promise<{ ok: boolean }>
  onBlockProof:         (callback: (proof: BlockProof) => void) => () => void
  resetUdpMonitor:      () => Promise<void>
  startUdpTracker:      () => Promise<void>
  stopUdpTracker:       () => Promise<void>
  onUdpUpdate: (callback: (result: TrackerResult) => void) => () => void
  checkFirewallHealth: () => Promise<FirewallHealthResult>
  checkForUpdate: () => Promise<UpdateInfo>
  downloadUpdate: () => Promise<void>
  installUpdate:  () => Promise<void>
  getServerStatus: () => Promise<ServerStatusResult>
  onLog:            (callback: (entry: LogEntry) => void) => () => void
  onStatusChange:   (callback: (regionId: string, blocked: boolean) => void) => () => void
  onCidrCount:      (callback: (regionId: string, count: number) => void) => () => void
  onUnblockAllDone: (callback: () => void) => () => void
  onUpdateDownloadProgress: (callback: (percent: number) => void) => () => void
  onUpdateDownloaded: (callback: () => void) => () => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
