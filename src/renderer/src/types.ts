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
}

export interface TrackerResult {
  dbdRunning: boolean
  current_server: string | null
  currentRegion: string | null
  confidence: number
  candidates: TrackerCandidate[]
  udpPorts: number[]
  dbdPid: number
  exitlagRunning: boolean
}

/** @deprecated use TrackerResult */
export type ActiveConnectionsResult = TrackerResult

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

export interface ElectronAPI {
  win: {
    minimize:    () => void
    maximize:    () => void
    close:       () => void
    isMaximized: () => Promise<boolean>
  }
  // Firewall
  blockRegion:   (regionId: string) => Promise<ActionResult>
  unblockRegion: (regionId: string) => Promise<ActionResult>
  unblockAll:    () => Promise<ActionResult>
  getStatus:     () => Promise<Record<string, boolean>>
  getCidrCounts: () => Promise<Record<string, number>>
  refreshIps:    () => Promise<{ added: number; removed: number }>
  isAdmin:       () => Promise<boolean>
  checkExePath:  () => Promise<ExeValidationResult>
  // Settings: exe path
  getExePath:  () => Promise<string>
  setExePath:  (path: string) => Promise<ExeValidationResult>
  browseExe:   () => Promise<string | null>
  // Settings: permanent regions
  getPermanentRegions: () => Promise<string[]>
  markPermanent:       (regionId: string) => Promise<void>
  unmarkPermanent:     (regionId: string) => Promise<void>
  // Tray sync
  sendBlockedCount: (count: number) => void
  // Ping
  pingRegion: (regionId: string) => Promise<PingResult>
  // UDP tracker
  getActiveConnections: () => Promise<TrackerResult>
  resetUdpMonitor:      () => Promise<void>
  startUdpTracker:      () => Promise<void>
  stopUdpTracker:       () => Promise<void>
  onUdpUpdate: (callback: (result: TrackerResult) => void) => () => void
  // WFP health check (console only)
  checkFirewallHealth: () => Promise<FirewallHealthResult>
  // Auto-update
  checkForUpdate: () => Promise<UpdateInfo>
  downloadUpdate: () => Promise<void>
  installUpdate:  () => Promise<void>
  // Server status (deadbyqueue)
  getServerStatus: () => Promise<ServerStatusResult>
  // Events
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
