import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync } from 'fs'
import {
  blockRegion,
  unblockRegion,
  getBlockedRegions,
  ruleExists,
  purgeAllWfp,
  checkFirewallHealth,
} from './firewall'
import { getCidrs, getCidrCounts, getCachedCidrs, fetchAndDiffCidrs } from './ips'
import { REGION_IDS } from './index'
import {
  getExePath,
  setExePath,
  validateExePath,
  getPermanentRegions,
  markPermanent,
  unmarkPermanent,
} from './settings'

const GITHUB_REPO = 'steaxs/dbd-blocker'

export type LogEmitter = (level: string, message: string) => void

// ── ETW connection tracker (Microsoft-Windows-Kernel-Network) ──────────────
interface TrackerOutput {
  dbdRunning:     boolean
  current_server: string | null
  confidence:     number
  candidates:     Array<{ ip: string; port: number; score: number; lastSeen: number; count: number }>
  udpPorts:       number[]
  dbdPid:         number
  exitlagRunning: boolean
  t:              number
}

interface TrackerResult {
  dbdRunning:     boolean
  current_server: string | null
  currentRegion:  string | null
  confidence:     number
  candidates:     Array<{ ip: string; port: number; score: number; lastSeen: number; count: number; regionId: string | null }>
  udpPorts:       number[]
  dbdPid:         number
  exitlagRunning: boolean
}

const EMPTY_RESULT: TrackerResult = {
  dbdRunning: false, current_server: null, currentRegion: null,
  confidence: 0, candidates: [], udpPorts: [], dbdPid: 0, exitlagRunning: false,
}

const trackerState = {
  lastResult: EMPTY_RESULT as TrackerResult,
}
let trackerProc: ChildProcess | null = null

// Cached CIDR data — refreshed every 60s so newly fetched ranges are picked up
let cidrCache: Array<{ regionId: string; cidrs: string[] }> | null = null
let cidrCacheTime = 0

async function getRegionCidrs(): Promise<Array<{ regionId: string; cidrs: string[] }>> {
  if (cidrCache && Date.now() - cidrCacheTime < 60_000) return cidrCache
  const result: Array<{ regionId: string; cidrs: string[] }> = []
  for (const regionId of REGION_IDS) {
    const cidrs = await getCachedCidrs(regionId)
    if (cidrs && cidrs.length > 0) result.push({ regionId, cidrs })
  }
  cidrCache = result
  cidrCacheTime = Date.now()
  return result
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) | parseInt(oct, 10)) >>> 0, 0)
}
function ipInCidr(ip: string, cidr: string): boolean {
  const [network, bits] = cidr.split('/')
  const prefix = parseInt(bits, 10)
  if (prefix === 0) return true
  const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0
  return (ipToInt(ip) & mask) === (ipToInt(network) & mask)
}
function matchRegion(ip: string, regionCidrs: Array<{ regionId: string; cidrs: string[] }>): string | null {
  for (const { regionId, cidrs } of regionCidrs) {
    for (const cidr of cidrs) {
      if (ipInCidr(ip, cidr)) return regionId
    }
  }
  return null
}

function getPsExe(): string {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const ps64 = `${sysRoot}\\SysNative\\WindowsPowerShell\\v1.0\\powershell.exe`
  return existsSync(ps64) ? ps64 : 'powershell'
}

function startTracker(win: BrowserWindow, log: LogEmitter): void {
  if (trackerProc) return

  const scriptPath = join(app.getAppPath(), 'scripts', 'etw-tracker.ps1')
  const proc = spawn(
    getPsExe(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { windowsHide: true }
  )
  trackerProc = proc

  log('info', '[Tracker] ETW session starting...')

  const rl = createInterface({ input: proc.stdout! })
  rl.on('line', async (line) => {
    line = line.trim()
    if (!line) return
    try {
      const data = JSON.parse(line) as TrackerOutput

      if (!data.dbdRunning) {
        trackerState.lastResult = { ...EMPTY_RESULT }
        if (!win.isDestroyed()) win.webContents.send('udp-update', trackerState.lastResult)
        return
      }

      const regionCidrs = await getRegionCidrs()

      const candidates = (data.candidates ?? []).map(c => ({
        ...c,
        regionId: matchRegion(c.ip, regionCidrs),
      }))

      const currentRegion = data.current_server
        ? matchRegion(data.current_server.split(':')[0], regionCidrs)
        : null

      const prev = trackerState.lastResult
      trackerState.lastResult = {
        dbdRunning:     true,
        current_server: data.current_server ?? null,
        currentRegion,
        confidence:     data.confidence,
        candidates,
        udpPorts:       data.udpPorts ?? [],
        dbdPid:         data.dbdPid,
        exitlagRunning: data.exitlagRunning ?? false,
      }

      // Log game server region change
      if (currentRegion && currentRegion !== prev.currentRegion) {
        log('success', `[Tracker] Game server: ${currentRegion} (${data.current_server}) confidence=${Math.round(data.confidence * 100)}%`)
      }
      // Log ExitLag detection
      if (data.exitlagRunning && !prev.exitlagRunning) {
        log('warning', '[Tracker] ExitLag detected — game server detection may show relay IPs instead of actual server')
      }

      if (!win.isDestroyed()) win.webContents.send('udp-update', trackerState.lastResult)
    } catch { /* ignore malformed JSON lines */ }
  })

  proc.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      const msg = line.trim()
      if (msg) log('step', msg)
    }
  })

  proc.on('close', (code) => {
    trackerProc = null
    log('warning', `[Tracker] Process exited (code=${code})`)
  })
}

function stopTracker(log: LogEmitter): void {
  if (trackerProc) {
    trackerProc.kill()
    trackerProc = null
    log('info', '[Tracker] Stopped')
  }
}

function makeLogEmitter(win: BrowserWindow): LogEmitter {
  return (level: string, message: string) => {
    const entry = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false }),
      level,
      message
    }
    if (!win.isDestroyed()) {
      win.webContents.send('log', entry)
    }
  }
}

function sendStatus(win: BrowserWindow, regionId: string, blocked: boolean): void {
  if (!win.isDestroyed()) {
    win.webContents.send('status-change', regionId, blocked)
  }
}

/**
 * Validates the configured DBD exe path.
 * Returns the path string if valid, null if not (and logs an error).
 * Applied as a guard before any block/unblock operation.
 */
async function requireValidExePath(log: LogEmitter): Promise<string | null> {
  const path = await getExePath()
  const validation = validateExePath(path)
  if (!validation.ok) {
    log('error', `DBD executable path is not configured or invalid — open Settings and set the correct path first. ${validation.error ?? ''}`.trim())
    return null
  }
  return path
}

export function registerIpcHandlers(win: BrowserWindow): void {
  const log = makeLogEmitter(win)

  // ── Firewall: block one region ─────────────────────────────────────────────
  ipcMain.handle('block-region', async (_, regionId: string) => {
    try {
      if (regionId === 'us-east-1') {
        const msg = 'Cannot block us-east-1 — DBD backend server runs in this region'
        log('error', msg)
        return { ok: false, error: msg }
      }

      const exePath = await requireValidExePath(log)
      if (!exePath) return { ok: false, error: 'DBD executable path not configured or invalid.' }

      log('info', `Blocking ${regionId}...`)
      const cidrs = await getCidrs(regionId)
      if (cidrs.length === 0) {
        log('warning', `${regionId}: no CIDRs available — run Refresh IPs first`)
        return { ok: false, error: 'No CIDRs available. Run Refresh IPs first.' }
      }
      const result = await blockRegion(regionId, cidrs, log, exePath)
      sendStatus(win, regionId, result.ok)
      return result
    } catch (err) {
      const error = String(err)
      log('error', `[${regionId}] Exception: ${error}`)
      return { ok: false, error }
    }
  })

  // ── Firewall: unblock one region ───────────────────────────────────────────
  ipcMain.handle('unblock-region', async (_, regionId: string) => {
    try {
      const exePath = await requireValidExePath(log)
      if (!exePath) return { ok: false, error: 'DBD executable path not configured or invalid.' }

      log('info', `Unblocking ${regionId}...`)
      const result = await unblockRegion(regionId, log)
      sendStatus(win, regionId, false)
      return result
    } catch (err) {
      const error = String(err)
      log('error', `[${regionId}] Exception: ${error}`)
      return { ok: false, error }
    }
  })

  // ── Firewall: unblock all (respects permanent regions) ────────────────────
  ipcMain.handle('unblock-all', async () => {
    const exePath = await requireValidExePath(log)
    if (!exePath) return

    log('info', 'Unblocking all regions...')
    for (const regionId of REGION_IDS) {
      try {
        if (await ruleExists(regionId)) {
          const result = await unblockRegion(regionId, log)
          sendStatus(win, regionId, !result.ok)
        }
      } catch (err) {
        log('error', `[${regionId}] Exception: ${String(err)}`)
      }
    }
    // Purge the WFP sublayer to remove any orphaned filters not tracked in state
    await purgeAllWfp(log)
    for (const regionId of REGION_IDS) sendStatus(win, regionId, false)
    log('success', 'Unblock All complete')
  })

  // ── Startup queries ────────────────────────────────────────────────────────
  ipcMain.handle('get-status', async () => getBlockedRegions(REGION_IDS))
  ipcMain.handle('get-cidr-counts', async () => getCidrCounts(REGION_IDS))

  // ── Refresh IPs ────────────────────────────────────────────────────────────
  ipcMain.handle('refresh-ips', async () => {
    log('info', 'Fetching AWS EC2 IP ranges...')
    let totalAdded = 0
    let totalRemoved = 0
    for (const regionId of REGION_IDS) {
      try {
        const { cidrs, added, removed } = await fetchAndDiffCidrs(regionId)
        totalAdded += added
        totalRemoved += removed
        const diff = added || removed ? ` (+${added}/-${removed})` : ''
        log('step', `${regionId}: ${cidrs.length} CIDRs${diff}`)
        win.webContents.send('cidr-count', regionId, cidrs.length)
      } catch (err) {
        log('error', `${regionId}: failed — ${String(err)}`)
      }
    }
    log('success', 'IP refresh complete')
    return { added: totalAdded, removed: totalRemoved }
  })

  // ── Validate current exe path (without saving) ────────────────────────────
  ipcMain.handle('check-exe-path', async () => {
    const path = await getExePath()
    return validateExePath(path)
  })

  // ── WFP health check — fire-and-forget, logs to console only ─────────────
  ipcMain.handle('check-firewall-health', () => {
    const { join } = require('path')
    checkFirewallHealth(log, join(app.getAppPath(), 'scripts', 'wfp-prereq.ps1'))
  })

  // ── Admin check ────────────────────────────────────────────────────────────
  ipcMain.handle('is-admin', async () => {
    try {
      const { execFileSync } = await import('child_process')
      execFileSync('net', ['session'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })

  // ── Settings: exe path ─────────────────────────────────────────────────────
  ipcMain.handle('get-exe-path', async () => getExePath())

  ipcMain.handle('set-exe-path', async (_, path: string) => {
    const validation = validateExePath(path)
    if (!validation.ok) return validation
    await setExePath(path)
    log('info', `DBD executable path updated: ${path}`)
    return validation
  })

  ipcMain.handle('browse-exe', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Dead by Daylight Executable',
      defaultPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dead by Daylight',
      filters: [{ name: 'Executable', extensions: ['exe'] }],
      properties: ['openFile']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ── Ping a region via GameLift HTTPS endpoint (same method as deadbyqueue.com) ──
  ipcMain.handle('ping-region', async (_, regionId: string) => {
    // GameLift/AWS ping hosts — identical to what deadbyqueue.com uses
    const PING_HOSTS: Record<string, string> = {
      'us-east-1':      'gamelift.us-east-1.amazonaws.com',
      'us-east-2':      'gamelift.us-east-2.amazonaws.com',
      'us-west-1':      'gamelift.us-west-1.amazonaws.com',
      'us-west-2':      'gamelift.us-west-2.amazonaws.com',
      'ca-central-1':   'gamelift.ca-central-1.amazonaws.com',
      'eu-central-1':   'gamelift.eu-central-1.amazonaws.com',
      'eu-west-1':      'gamelift.eu-west-1.amazonaws.com',
      'eu-west-2':      'gamelift.eu-west-2.amazonaws.com',
      'ap-south-1':     'gamelift.ap-south-1.amazonaws.com',
      'ap-east-1':      'dynamodb.ap-east-1.amazonaws.com',   // GameLift not available in HK
      'ap-northeast-1': 'gamelift.ap-northeast-1.amazonaws.com',
      'ap-northeast-2': 'gamelift.ap-northeast-2.amazonaws.com',
      'ap-southeast-1': 'gamelift.ap-southeast-1.amazonaws.com',
      'ap-southeast-2': 'gamelift.ap-southeast-2.amazonaws.com',
      'sa-east-1':      'gamelift.sa-east-1.amazonaws.com',
    }

    const host = PING_HOSTS[regionId]
    if (!host) return { ok: false, ip: null, ms: null, error: 'Unknown region' }

    const { default: https } = await import('https')

    // Run 4 pings, return median (same approach as deadbyqueue)
    async function singlePing(): Promise<number | null> {
      return new Promise((resolve) => {
        const start = Date.now()
        const req = https.request({
          hostname: host,
          port: 443,
          path: '/ping',
          method: 'HEAD',
          timeout: 5000,
          rejectUnauthorized: false,
        }, (res) => {
          res.resume()
          resolve(Date.now() - start)
        })
        req.on('error', () => resolve(null))
        req.on('timeout', () => { req.destroy(); resolve(null) })
        req.end()
      })
    }

    // Warm up connection (first request often slow due to TCP/TLS handshake)
    await singlePing()

    // 6 real samples after warmup
    const samples: number[] = []
    for (let i = 0; i < 6; i++) {
      const ms = await singlePing()
      if (ms !== null) samples.push(ms)
    }

    if (samples.length === 0) return { ok: true, ip: host, ms: null }

    // Trimmed mean: discard highest and lowest, average the rest
    samples.sort((a, b) => a - b)
    const trimmed = samples.length > 2 ? samples.slice(1, -1) : samples
    const avg = Math.round(trimmed.reduce((s, v) => s + v, 0) / trimmed.length)
    return { ok: true, ip: host, ms: avg }
  })

  // ── UDP tracker: returns last known state ──────────────────────────────────
  ipcMain.handle('get-active-connections', () => trackerState.lastResult)

  // ── Reset tracker — clears detected server without stopping tracker ────────
  ipcMain.handle('reset-udp-monitor', () => {
    trackerState.lastResult = {
      ...trackerState.lastResult,
      current_server: null,
      currentRegion:  null,
      confidence:     0,
      candidates:     [],
    }
    if (!win.isDestroyed()) win.webContents.send('udp-update', trackerState.lastResult)
    log('info', '[Tracker] Server cleared')
  })

  // ── Manual start/stop (tracker is OFF by default, user enables it) ────────
  ipcMain.handle('start-udp-tracker', () => startTracker(win, log))
  ipcMain.handle('stop-udp-tracker',  () => stopTracker(log))

  // ── Settings: permanent regions ────────────────────────────────────────────
  ipcMain.handle('get-permanent-regions', async () => getPermanentRegions())

  ipcMain.handle('mark-permanent', async (_, regionId: string) => {
    await markPermanent(regionId)
    log('warning', `[${regionId}] Marked as permanent — rule will persist after app close`)
  })

  ipcMain.handle('unmark-permanent', async (_, regionId: string) => {
    await unmarkPermanent(regionId)
    log('info', `[${regionId}] Permanent flag removed — rule will be cleared on app close`)
  })

  // ── Server status from deadbyqueue API ────────────────────────────────────
  ipcMain.handle('get-server-status', async () => {
    try {
      const { default: https } = await import('https')

      function fetchJson(url: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
          const req = https.get(url, { timeout: 8000 }, (res) => {
            let data = ''
            res.on('data', (chunk) => (data += chunk))
            res.on('end', () => {
              try { resolve(JSON.parse(data)) }
              catch { reject(new Error('Invalid JSON')) }
            })
          })
          req.on('error', reject)
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
        })
      }

      const [regionsData, queuesData] = await Promise.all([
        fetchJson('https://api2.deadbyqueue.com/regions'),
        fetchJson('https://api2.deadbyqueue.com/queues'),
      ])

      const onlineMap = (regionsData as any).regions as Record<string, boolean>
      const liveQueues = ((queuesData as any).queues?.live ?? {}) as Record<
        string,
        { killer: { time: string }; survivor: { time: string } }
      >

      const result: Record<string, { online: boolean; killerQueue: string | null; survivorQueue: string | null }> = {}
      const allIds = new Set([...Object.keys(onlineMap), ...Object.keys(liveQueues)])
      for (const id of allIds) {
        result[id] = {
          online:        onlineMap[id] ?? false,
          killerQueue:   liveQueues[id]?.killer?.time   ?? null,
          survivorQueue: liveQueues[id]?.survivor?.time ?? null,
        }
      }
      return { ok: true, data: result }
    } catch {
      return { ok: false, data: {} }
    }
  })

  // ── Auto-update: check GitHub releases ─────────────────────────────────────
  ipcMain.handle('check-for-update', async () => {
    try {
      const { default: https } = await import('https')
      const current = app.getVersion()

      const data = await new Promise<string>((resolve, reject) => {
        https.get(
          `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
          { headers: { 'User-Agent': 'dbd-blocker' } },
          (res) => {
            let body = ''
            res.on('data', (chunk) => (body += chunk))
            res.on('end', () => resolve(body))
          }
        ).on('error', reject)
      })

      const release = JSON.parse(data) as { tag_name: string; prerelease: boolean; html_url: string }

      if (release.prerelease) return { available: false, version: current, url: '' }

      const latest = release.tag_name.replace(/^v/, '')

      // Simple semver compare: split by dots and compare numerically
      const toNum = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0)
      const [ca, cb, cc] = toNum(current)
      const [la, lb, lc] = toNum(latest)
      const newer = la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc)

      return { available: newer, version: latest, url: release.html_url }
    } catch {
      return { available: false, version: app.getVersion(), url: '' }
    }
  })
}
