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

  // Ping
  pingRegion: (regionId: string) => ipcRenderer.invoke('ping-region', regionId),

  // UDP tracker
  getActiveConnections: () => ipcRenderer.invoke('get-active-connections'),
  resetUdpMonitor:      () => ipcRenderer.invoke('reset-udp-monitor'),
  startUdpTracker:      () => ipcRenderer.invoke('start-udp-tracker'),
  stopUdpTracker:       () => ipcRenderer.invoke('stop-udp-tracker'),

  // WFP health check (fire-and-forget — logs to console)
  checkFirewallHealth: () => ipcRenderer.invoke('check-firewall-health'),

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
  },
  onUdpUpdate: (callback: (result: unknown) => void) => {
    const handler = (_: unknown, result: unknown) => callback(result)
    ipcRenderer.on('udp-update', handler)
    return () => ipcRenderer.removeListener('udp-update', handler)
  }
})
