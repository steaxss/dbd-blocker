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

export interface PingResult {
  ok: boolean
  ip: string | null
  ms: number | null
  error?: string
}

export interface UdpRegion {
  regionId: string
  ip: string
}

export interface ActiveConnectionsResult {
  running: boolean
  udpRegions: UdpRegion[]
}

export interface FirewallHealthResult {
  healthy: boolean
  issue?: string
  cause?: 'wfp-broken' | 'third-party'
}

export interface RepairStepState {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'error' | 'warning'
  detail?: string
}

export interface RepairResult {
  ok: boolean
  backupPath?: string
  needsReboot: boolean
  error?: string
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

export interface ElectronAPI {
  win: {
    minimize:    () => void
    maximize:    () => void
    close:       () => void
    isMaximized: () => Promise<boolean>
  }
  // Firewall
  blockRegion:   (regionId: string) => Promise<{ ok: boolean; error?: string }>
  unblockRegion: (regionId: string) => Promise<{ ok: boolean; error?: string }>
  unblockAll:    () => Promise<void>
  blockExcept:   (keepRegionId: string) => Promise<void>
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
  // Settings: exclusive region
  getExclusiveRegion: () => Promise<string | null>
  setExclusiveRegion: (regionId: string | null) => Promise<void>
  // Tray sync
  sendBlockedCount: (count: number) => void
  // Ping
  pingRegion: (regionId: string) => Promise<PingResult>
  // Active connections
  getActiveConnections: () => Promise<ActiveConnectionsResult>
  resetUdpMonitor:      () => Promise<void>
  // Firewall health check + repair
  checkFirewallHealth: () => Promise<FirewallHealthResult>
  repairFirewall:      () => Promise<RepairResult>
  onRepairProgress:    (callback: (update: { id: string; status: string; detail?: string }) => void) => () => void
  // Auto-update
  checkForUpdate: () => Promise<UpdateInfo>
  // Server status (deadbyqueue)
  getServerStatus: () => Promise<ServerStatusResult>
  // Events
  onLog:            (callback: (entry: LogEntry) => void) => () => void
  onStatusChange:   (callback: (regionId: string, blocked: boolean) => void) => () => void
  onCidrCount:      (callback: (regionId: string, count: number) => void) => () => void
  onUnblockAllDone: (callback: () => void) => () => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
