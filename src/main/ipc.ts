import { ipcMain, dialog, app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import https from 'https'
import { join } from 'path'
import { getScriptPath } from './paths'
import { runScript } from './powershell'
import {
  applyPersistence,
  blockRegion,
  getBlockedMap,
  isBlocked,
  syncBlockedWithRanges,
  unblockAll,
  unblockRegion,
  type LogEmitter,
} from './blocker'
import { getRangeCounts, refreshRanges } from './ips'
import { isBlockableRegion, isRegionId, REGION_IDS } from './regions'
import {
  getExePath,
  setExePath,
  validateExePath,
  getPermanentRegions,
  markPermanent,
  unmarkPermanent,
} from './settings'
import { autoDetectDbdExePath } from './steam'
import { pingRegion } from './ping'
import {
  getTrackerState,
  invalidateRegionMatcher,
  resetTracker,
  startTracker,
  stopTracker,
  type TrackerDeps,
} from './tracker'
import { checkForUpdate, downloadUpdate, installUpdate } from './updater'

export interface FirewallHealthResult {
  ok: boolean
  details: string[]
  error?: string
}

const AUTO_REFRESH_MS = 6 * 60 * 60 * 1000

export function makeLogEmitter(win: BrowserWindow): LogEmitter {
  let seq = 0
  return (level, message) => {
    if (win.isDestroyed()) return
    win.webContents.send('log', {
      id: `${Date.now()}-${seq++}`,
      timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false }),
      level,
      message,
    })
  }
}

function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        data += chunk
        if (data.length > 1_000_000) req.destroy(new Error('Response too large'))
      })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Timeout')))
  })
}

function isElevated(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'net.exe'), ['session'], { windowsHide: true, timeout: 10_000 }, (err) => resolve(!err))
  })
}

export function registerIpcHandlers(win: BrowserWindow, log: LogEmitter, ready: Promise<void>): void {
  /** Only the main window may call handlers, and only once the startup reconciliation is done. */
  const guard = <A extends unknown[], R>(handler: (...args: A) => Promise<R> | R) =>
    async (event: IpcMainInvokeEvent, ...args: A): Promise<R> => {
      if (event.sender !== win.webContents) throw new Error('Unauthorized IPC sender')
      await ready
      return handler(...args)
    }

  const sendStatus = (regionId: string, blocked: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send('status-change', regionId, blocked)
  }
  const sendAllStatus = (): void => {
    for (const [id, blocked] of Object.entries(getBlockedMap())) sendStatus(id, blocked)
  }

  const trackerDeps: TrackerDeps = {
    log,
    isBlocked,
    emit: (result) => { if (!win.isDestroyed()) win.webContents.send('udp-update', result) },
  }

  let refreshing: Promise<{ added: number; removed: number; resynced: string[] }> | null = null
  const doRefresh = (): Promise<{ added: number; removed: number; resynced: string[] }> => {
    if (refreshing) return refreshing
    refreshing = (async () => {
      log('info', 'Fetching AWS IP ranges (EC2, IPv4 + IPv6)...')
      const refreshed = await refreshRanges()
      invalidateRegionMatcher()
      let added = 0
      let removed = 0
      for (const id of REGION_IDS) {
        const r = refreshed.regions[id]
        added += r.added
        removed += r.removed
        const diff = r.added || r.removed ? ` (+${r.added}/-${r.removed})` : ''
        log('step', `${id}: ${r.cidrs.length} ranges${diff}`)
        if (!win.isDestroyed()) win.webContents.send('cidr-count', id, r.cidrs.length)
      }
      log('success', `AWS ranges up to date (published ${refreshed.createDate || 'n/a'})`)
      const resynced = await syncBlockedWithRanges(log)
      return { added, removed, resynced }
    })().finally(() => { refreshing = null })
    return refreshing
  }

  // AWS publishes new ranges several times a week: keep active blocks current while the app runs.
  const autoRefresh = setInterval(() => {
    doRefresh().catch((err) => log('warning', `Automatic AWS range refresh failed: ${String(err)}`))
  }, AUTO_REFRESH_MS)
  app.once('before-quit', () => clearInterval(autoRefresh))

  ipcMain.handle('block-region', guard(async (regionId: unknown) => {
    if (!isBlockableRegion(regionId)) {
      const error = regionId === 'us-east-1'
        ? 'us-east-1 cannot be blocked: Dead by Daylight backend services run there.'
        : 'Unknown region'
      log('error', error)
      return { ok: false, error, code: 'region_not_blockable' }
    }
    log('info', `Blocking ${regionId}...`)
    const result = await blockRegion(regionId, log)
    sendStatus(regionId, isBlocked(regionId))
    return result
  }))

  ipcMain.handle('unblock-region', guard(async (regionId: unknown) => {
    if (!isRegionId(regionId)) return { ok: false, error: 'Unknown region', code: 'unknown_region' }
    log('info', `Unblocking ${regionId}...`)
    const result = await unblockRegion(regionId, log)
    sendStatus(regionId, isBlocked(regionId))
    return result
  }))

  ipcMain.handle('unblock-all', guard(async () => {
    log('info', 'Unblocking all regions...')
    const result = await unblockAll(log)
    sendAllStatus()
    return result
  }))

  ipcMain.handle('get-status', guard(() => getBlockedMap()))
  ipcMain.handle('get-cidr-counts', guard(() => getRangeCounts()))
  ipcMain.handle('refresh-ips', guard(() => doRefresh()))

  ipcMain.handle('check-exe-path', guard(async () => validateExePath(await getExePath())))

  ipcMain.handle('check-firewall-health', guard(async (): Promise<FirewallHealthResult> => {
    const res = await runScript(getScriptPath('wfp-prereq.ps1'), [], { timeoutMs: 60_000 })
    const details = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    for (const line of details) {
      log(line.startsWith('FAIL') || line.includes('RESULT: FAIL') ? 'warning' : line.startsWith('OK') || line.includes('RESULT: PASS') ? 'success' : 'step', `[WFP] ${line}`)
    }
    const ok = res.code === 0 && details.some((l) => l.includes('RESULT: PASS')) && !details.some((l) => l.startsWith('FAIL'))
    return ok ? { ok, details } : { ok, details, error: details.find((l) => l.startsWith('FAIL')) ?? res.stderr ?? `Health check failed (code=${res.code})` }
  }))

  ipcMain.handle('is-admin', guard(() => isElevated()))

  ipcMain.handle('get-exe-path', guard(() => getExePath()))
  ipcMain.handle('get-app-version', guard(() => app.getVersion()))

  ipcMain.handle('set-exe-path', guard(async (path: unknown) => {
    if (typeof path !== 'string') return { ok: false, error: 'Invalid path' }
    const validation = validateExePath(path)
    if (!validation.ok) return validation
    await setExePath(path)
    log('info', `DBD executable path updated: ${path}`)
    return validation
  }))

  ipcMain.handle('browse-exe', guard(async () => {
    const currentPath = await getExePath()
    const dir = currentPath.split(/[/\\]/).slice(0, -1).join('\\') || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dead by Daylight'
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Dead by Daylight Executable',
      defaultPath: existsSync(dir) ? dir : undefined,
      filters: [{ name: 'Executable', extensions: ['exe'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }))

  ipcMain.handle('auto-detect-exe', guard(() => {
    const result = autoDetectDbdExePath()
    if (result.found && result.path) log('info', `Auto-detected DBD executable: ${result.path}`)
    else log('warning', `Auto-detect failed: ${result.error ?? 'Unknown error'}`)
    return result
  }))

  ipcMain.handle('ping-region', guard(async (regionId: unknown) => {
    if (!isRegionId(regionId)) return { ok: false, ip: null, ms: null, error: 'Unknown region' }
    return pingRegion(regionId)
  }))

  ipcMain.handle('get-active-connections', guard(() => getTrackerState()))
  ipcMain.handle('reset-udp-monitor', guard(() => {
    resetTracker(trackerDeps)
    log('info', '[Tracker] Server cleared')
  }))
  ipcMain.handle('start-udp-tracker', guard(() => startTracker(trackerDeps)))
  ipcMain.handle('stop-udp-tracker', guard(() => stopTracker()))

  ipcMain.handle('get-permanent-regions', guard(() => getPermanentRegions()))

  ipcMain.handle('mark-permanent', guard(async (regionId: unknown) => {
    if (!isBlockableRegion(regionId)) return
    await markPermanent(regionId)
    await applyPersistence(regionId, true, log)
    log('warning', `[${regionId}] Marked as permanent: the block survives app exit and reboots`)
  }))

  ipcMain.handle('unmark-permanent', guard(async (regionId: unknown) => {
    if (!isRegionId(regionId)) return
    await unmarkPermanent(regionId)
    await applyPersistence(regionId, false, log)
    log('info', `[${regionId}] Permanent flag removed: the block will be cleared on app exit`)
  }))

  ipcMain.handle('get-server-status', guard(async () => {
    try {
      const [regionsData, queuesData] = await Promise.all([
        fetchJson('https://api2.deadbyqueue.com/regions', 8000),
        fetchJson('https://api2.deadbyqueue.com/queues', 8000),
      ])
      const onlineMap = ((regionsData as { regions?: Record<string, boolean> })?.regions ?? {})
      const liveQueues = ((queuesData as { queues?: { live?: Record<string, { killer?: { time?: string }; survivor?: { time?: string } }> } })?.queues?.live ?? {})
      const result: Record<string, { online: boolean; killerQueue: string | null; survivorQueue: string | null }> = {}
      for (const id of new Set([...Object.keys(onlineMap), ...Object.keys(liveQueues)])) {
        result[id] = {
          online: onlineMap[id] === true,
          killerQueue: liveQueues[id]?.killer?.time ?? null,
          survivorQueue: liveQueues[id]?.survivor?.time ?? null,
        }
      }
      return { ok: true, data: result }
    } catch {
      return { ok: false, data: {} }
    }
  }))

  ipcMain.handle('check-for-update', guard(() => checkForUpdate()))
  ipcMain.handle('download-update', guard(() => downloadUpdate()))
  ipcMain.handle('install-update', guard(() => installUpdate()))
}
