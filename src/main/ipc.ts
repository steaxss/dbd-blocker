import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron'
import {
  blockRegion,
  unblockRegion,
  getBlockedRegions,
  ruleExists,
  purgeAllWfp,
  ps,
  checkFirewallHealth,
  repairFirewall
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
  getExclusiveRegion,
  setExclusiveRegion
} from './settings'

const GITHUB_REPO = 'steaxs/dbd-blocker'

export type LogEmitter = (level: string, message: string) => void

// ── UDP monitor state (persists across polls) ──────────────────────────────
const WFP_GUID = '{0CCE9226-69AE-11D9-BED3-505054503030}'
const udpMonitor = {
  dbdRunning:       false,
  auditWasEnabled:  false,
  regionMap:        new Map<string, string>(), // ip → regionId
  lastPollMs:       0,
  loggedSecErr:     false,
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

export function registerIpcHandlers(win: BrowserWindow): void {
  const log = makeLogEmitter(win)

  // ── Firewall: block one region ─────────────────────────────────────────────
  ipcMain.handle('block-region', async (_, regionId: string) => {
    try {
      log('info', `Blocking ${regionId}...`)
      const cidrs = await getCidrs(regionId)
      if (cidrs.length === 0) {
        log('warning', `${regionId}: no CIDRs available — run Refresh IPs first`)
        return { ok: false, error: 'No CIDRs available. Run Refresh IPs first.' }
      }
      const result = await blockRegion(regionId, cidrs, log)
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

  // ── Exclusive mode: block all except one region ───────────────────────────
  ipcMain.handle('block-except', async (_, keepRegionId: string) => {
    log('info', `Exclusive mode: keeping only ${keepRegionId} open...`)
    for (const regionId of REGION_IDS) {
      try {
        if (regionId === keepRegionId) {
          // Ensure this region is unblocked
          if (await ruleExists(regionId)) {
            await unblockRegion(regionId, log)
            sendStatus(win, regionId, false)
          }
        } else {
          const cidrs = await getCidrs(regionId)
          if (cidrs.length === 0) {
            log('warning', `${regionId}: skipped (no CIDRs)`)
            continue
          }
          const result = await blockRegion(regionId, cidrs, log)
          sendStatus(win, regionId, result.ok)
        }
      } catch (err) {
        log('error', `[${regionId}] Exception: ${String(err)}`)
      }
    }
    log('success', `Exclusive mode active — only ${keepRegionId} is reachable`)
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

  // ── Firewall health check (WFP direct API prereq test) ────────────────────
  ipcMain.handle('check-firewall-health', async () => {
    const { join } = await import('path')
    const scriptPath = join(app.getAppPath(), 'scripts', 'wfp-prereq.ps1')
    return checkFirewallHealth(log, scriptPath)
  })

  // ── Firewall auto-repair ───────────────────────────────────────────────────
  ipcMain.handle('repair-firewall', async () => {
    const onStep = (update: { id: string; status: string; detail?: string }) => {
      if (!win.isDestroyed()) win.webContents.send('repair-progress', update)
    }
    return repairFirewall(log, onStep, app.getPath('userData'))
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

  // ── Get active DBD UDP connections (automatic, no user interaction) ────────
  //
  // Uses Windows Security Event 5156 (WFP ALE permit) which fires at the FIRST
  // layer of the WFP stack — before any VPN/ExitLag/GPN redirect callout.
  // GUID-based auditpol subcategory to work on any Windows locale.
  //
  ipcMain.handle('get-active-connections', async () => {
    // 1. Find DBD PID
    const pidRes = await ps(
      `(Get-Process -Name 'DeadByDaylight-Win64-Shipping' -ErrorAction SilentlyContinue).Id`
    )
    const pid = parseInt(pidRes.stdout.trim(), 10)
    const isRunning = !isNaN(pid) && pid > 0

    if (!isRunning) {
      if (udpMonitor.dbdRunning) {
        // DBD just stopped — restore audit state and clear accumulated data
        udpMonitor.dbdRunning = false
        udpMonitor.regionMap.clear()
        if (!udpMonitor.auditWasEnabled) {
          await ps(`auditpol /set /subcategory:"${WFP_GUID}" /success:disable`)
          log('info', '[UDP] DBD stopped — WFP audit disabled')
        } else {
          log('info', '[UDP] DBD stopped — WFP audit preserved (was already active)')
        }
      }
      return { running: false, udpRegions: [] }
    }

    // 2. DBD just started — enable audit monitoring
    if (!udpMonitor.dbdRunning) {
      udpMonitor.dbdRunning = true
      udpMonitor.regionMap.clear()
      log('info', `[UDP] DBD detected (PID: ${pid}) — configuring WFP audit...`)

      // Check if WFP audit was already enabled (language-independent GUID)
      const checkRes = await ps(
        `((auditpol /get /subcategory:"${WFP_GUID}" 2>&1) -join ' ') -match 'Success'`
      )
      udpMonitor.auditWasEnabled = checkRes.stdout.trim().toLowerCase() === 'true'

      if (!udpMonitor.auditWasEnabled) {
        const enableRes = await ps(
          `auditpol /set /subcategory:"${WFP_GUID}" /success:enable 2>&1`
        )
        if (enableRes.stdout.toLowerCase().includes('success') || enableRes.ok) {
          log('info', '[UDP] WFP audit enabled — Security Event 5156 active')
        } else {
          log('warning', `[UDP] WFP audit enable failed: ${enableRes.stdout || enableRes.stderr}`)
        }
      } else {
        log('info', '[UDP] WFP audit already active')
      }

      // On first poll look back 10s to catch connections made just before app opened
      udpMonitor.lastPollMs = Date.now() - 10000
    }

    // 3. Query Security log for new 5156 UDP events from DBD since last poll
    //    Properties: [0]=ProcessId [1]=Application [2]=Direction [3]=SrcAddr [4]=SrcPort
    //                [5]=DestAddr [6]=DestPort [7]=Protocol (17=UDP)
    const sinceMs = udpMonitor.lastPollMs - 1000 // 1s overlap to avoid missing events
    udpMonitor.lastPollMs = Date.now()

    const evtRes = await ps(
      `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${sinceMs}).LocalDateTime; ` +
      `$dbdPid = ${pid}; ` +
      `$ips = [System.Collections.Generic.HashSet[string]]::new(); ` +
      `$err = $null; ` +
      `try { ` +
        `Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=5156; StartTime=$since } ` +
        `-ErrorAction Stop | ` +
        `Where-Object { [string]$_.Properties[0].Value -eq [string]$dbdPid -and $_.Properties[7].Value -eq 17 } | ` +
        `ForEach-Object { ` +
        `  $dst = [string]$_.Properties[5].Value; ` +
        `  if ($dst -and $dst -notmatch '^(127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|::1|0\\.0|255\\.|169\\.254\\.)') { ` +
        `    [void]$ips.Add($dst) ` +
        `  } ` +
        `} ` +
      `} catch { $err = $_.Exception.Message }; ` +
      `$out = @{ ips = if ($ips.Count -gt 0) { [string[]]$ips } else { @() }; err = $err }; ` +
      `$out | ConvertTo-Json -Compress`
    )

    // 4. Match new IPs against cached AWS CIDRs and accumulate
    try {
      const raw = JSON.parse(evtRes.stdout.trim()) as { ips: string[]; err: string | null }
      const newIps: string[] = Array.isArray(raw.ips) ? raw.ips : []

      // Surface Security log errors once per DBD session
      if (raw.err && !udpMonitor.loggedSecErr) {
        udpMonitor.loggedSecErr = true
        // "No events found" is normal (no new connections), only log real errors
        if (!raw.err.toLowerCase().includes('no events') && !raw.err.toLowerCase().includes('no matching')) {
          log('warning', `[UDP] Security log: ${raw.err}`)
        }
      }
      if (!raw.err) udpMonitor.loggedSecErr = false

      if (newIps.length > 0) {
        const regionCidrs: Array<{ regionId: string; cidrs: string[] }> = []
        for (const regionId of REGION_IDS) {
          const cidrs = await getCachedCidrs(regionId)
          if (cidrs) regionCidrs.push({ regionId, cidrs })
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

        for (const ip of newIps) {
          if (udpMonitor.regionMap.has(ip)) continue
          for (const { regionId, cidrs } of regionCidrs) {
            let matched = false
            for (const cidr of cidrs) {
              if (ipInCidr(ip, cidr)) {
              udpMonitor.regionMap.set(ip, regionId)
              log('success', `[UDP] Game server detected: ${regionId} (${ip})`)
              matched = true; break
            }
            }
            if (matched) break
          }
        }
      }
    } catch { /* parse error */ }

    // 5. Build unique-per-region list (first IP seen per region)
    const regionToIp = new Map<string, string>()
    for (const [ip, regionId] of udpMonitor.regionMap) {
      if (!regionToIp.has(regionId)) regionToIp.set(regionId, ip)
    }
    const udpRegions = [...regionToIp.entries()].map(([regionId, ip]) => ({ regionId, ip }))

    return { running: true, udpRegions }
  })

  // ── Reset UDP monitor (clear accumulated game servers) ─────────────────────
  ipcMain.handle('reset-udp-monitor', () => {
    udpMonitor.regionMap.clear()
    log('info', '[UDP] Game server list cleared')
  })

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

  // ── Settings: exclusive region (permanent exclusive mode) ──────────────────
  ipcMain.handle('get-exclusive-region', async () => getExclusiveRegion())

  ipcMain.handle('set-exclusive-region', async (_, regionId: string | null) => {
    await setExclusiveRegion(regionId)
    if (regionId) {
      log('warning', `[${regionId}] Exclusive mode saved — will be restored on next launch`)
    } else {
      log('info', 'Exclusive mode unsaved')
    }
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
