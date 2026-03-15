import { contextBridge, ipcRenderer } from 'electron'
import type { LogEntry } from '../renderer/src/types'

contextBridge.exposeInMainWorld('api', {
  // Window controls
  win: {
    minimize:    () => ipcRenderer.send('win:minimize'),
    maximize:    () => ipcRenderer.send('win:maximize'),
    close:       () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized')
  },

  // Firewall
  blockRegion:   (regionId: string) => ipcRenderer.invoke('block-region', regionId),
  unblockRegion: (regionId: string) => ipcRenderer.invoke('unblock-region', regionId),
  unblockAll:    () => ipcRenderer.invoke('unblock-all'),
  blockExcept:   (keepRegionId: string) => ipcRenderer.invoke('block-except', keepRegionId),
  getStatus:     () => ipcRenderer.invoke('get-status'),
  getCidrCounts: () => ipcRenderer.invoke('get-cidr-counts'),
  refreshIps:    () => ipcRenderer.invoke('refresh-ips'),
  isAdmin:       () => ipcRenderer.invoke('is-admin'),
  checkExePath:  () => ipcRenderer.invoke('check-exe-path'),

  // Settings: exe path
  getExePath:  () => ipcRenderer.invoke('get-exe-path'),
  setExePath:  (path: string) => ipcRenderer.invoke('set-exe-path', path),
  browseExe:   () => ipcRenderer.invoke('browse-exe'),

  // Settings: permanent regions
  getPermanentRegions: () => ipcRenderer.invoke('get-permanent-regions'),
  markPermanent:       (regionId: string) => ipcRenderer.invoke('mark-permanent', regionId),
  unmarkPermanent:     (regionId: string) => ipcRenderer.invoke('unmark-permanent', regionId),

  // Settings: exclusive region (persistent exclusive mode)
  getExclusiveRegion: () => ipcRenderer.invoke('get-exclusive-region'),
  setExclusiveRegion: (regionId: string | null) => ipcRenderer.invoke('set-exclusive-region', regionId),

  // Ping
  pingRegion: (regionId: string) => ipcRenderer.invoke('ping-region', regionId),

  // Active connections
  getActiveConnections: () => ipcRenderer.invoke('get-active-connections'),
  resetUdpMonitor:      () => ipcRenderer.invoke('reset-udp-monitor'),

  // Firewall health check + repair
  checkFirewallHealth: () => ipcRenderer.invoke('check-firewall-health'),
  repairFirewall:      () => ipcRenderer.invoke('repair-firewall'),

  onRepairProgress: (callback: (update: { id: string; status: string; detail?: string }) => void) => {
    const handler = (_: unknown, update: { id: string; status: string; detail?: string }) => callback(update)
    ipcRenderer.on('repair-progress', handler)
    return () => ipcRenderer.removeListener('repair-progress', handler)
  },

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),

  // Server status (deadbyqueue)
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),

  // Tray sync
  sendBlockedCount: (count: number) => ipcRenderer.send('blocked-count-update', count),

  // Events: main → renderer
  onLog: (callback: (entry: LogEntry) => void) => {
    const handler = (_: unknown, entry: LogEntry) => callback(entry)
    ipcRenderer.on('log', handler)
    return () => ipcRenderer.removeListener('log', handler)
  },
  onStatusChange: (callback: (regionId: string, blocked: boolean) => void) => {
    const handler = (_: unknown, regionId: string, blocked: boolean) => callback(regionId, blocked)
    ipcRenderer.on('status-change', handler)
    return () => ipcRenderer.removeListener('status-change', handler)
  },
  onCidrCount: (callback: (regionId: string, count: number) => void) => {
    const handler = (_: unknown, regionId: string, count: number) => callback(regionId, count)
    ipcRenderer.on('cidr-count', handler)
    return () => ipcRenderer.removeListener('cidr-count', handler)
  },
  onUnblockAllDone: (callback: () => void) => {
    ipcRenderer.on('unblock-all-done', callback)
    return () => ipcRenderer.removeListener('unblock-all-done', callback)
  }
})
