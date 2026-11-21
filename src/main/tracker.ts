// Live game-server tracker: owns the etw-tracker.ps1 process and maps observed IPs to AWS regions.
import { execFile, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { join } from 'path'
import { CidrMatcher } from './cidr'
import { estimateRelayRegion } from './relays'
import { getAllRanges, getGlobalEc2Ranges } from './ips'
import { getScriptPath } from './paths'
import { spawnScript } from './powershell'
import { DBD_PROCESS_NAMES } from './settings'
import type { LogEmitter } from './blocker'

const ETW_SESSION = 'DBD-Blocker-ETW'

/** Pseudo-region for AWS EC2 "GLOBAL" ranges: GameLift Player Gateway relays, real server region hidden. */
export const RELAY_REGION = 'aws-relay'


interface TrackerLine {
  dbdRunning: boolean
  dbdPid: number
  current_server: string | null
  currentIp: string | null
  confidence: number
  candidates: Array<{ ip: string; port: number; score: number; lastSeen: number; count: number; bytes?: number; v6?: boolean }>
  udpPorts: number[]
  exitlagRunning: boolean
  t: number
}

export interface TrackerResult {
  dbdRunning: boolean
  current_server: string | null
  currentIp: string | null
  currentRegion: string | null
  /** The game is talking to a server inside a region the user blocked. */
  blockedRegionHit: boolean
  /** The game talks to an AWS GameLift relay: the IP does not tell which region the server is in. */
  viaRelay: boolean
  /** Region of the relay, estimated from public geolocation data (relays sit next to the game servers). */
  estimatedRegion: string | null
  /** Regions whose GameLift ping beacon the game contacted recently (matchmaking latency checks). */
  pingedRegions: Array<{ region: string; blocked: boolean }>
  confidence: number
  candidates: Array<{ ip: string; port: number; score: number; lastSeen: number; count: number; regionId: string | null; estimated?: boolean }>
  udpPorts: number[]
  dbdPid: number
  exitlagRunning: boolean
}

export const EMPTY_TRACKER: TrackerResult = {
  dbdRunning: false, current_server: null, currentIp: null, currentRegion: null, blockedRegionHit: false, viaRelay: false, estimatedRegion: null, pingedRegions: [],
  confidence: 0, candidates: [], udpPorts: [], dbdPid: 0, exitlagRunning: false,
}

export interface TrackerDeps {
  log: LogEmitter
  emit: (result: TrackerResult) => void
  isBlocked: (regionId: string) => boolean
}

let proc: ChildProcess | null = null
let last: TrackerResult = { ...EMPTY_TRACKER }
let matcher: CidrMatcher | null = null
let lastUnknownIp: string | null = null
let lastLeakKey: string | null = null
/** Regions the game pinged recently (GameLift beacons, matchmaking latency), with the last time seen. */
const pinged = new Map<string, number>()
const BEACON_PORT = 7770
const PING_MEMORY_MS = 10 * 60 * 1000

export function getTrackerState(): TrackerResult {
  return last
}

export function invalidateRegionMatcher(): void {
  matcher = null
}

async function getMatcher(): Promise<CidrMatcher> {
  if (matcher) return matcher
  const m = new CidrMatcher()
  for (const [regionId, cidrs] of Object.entries(await getAllRanges())) m.add(regionId, cidrs)
  // Less specific than regional ranges, so a regional match always wins (longest prefix).
  m.add(RELAY_REGION, await getGlobalEc2Ranges())
  matcher = m
  return m
}

export function resetTracker(deps: TrackerDeps): void {
  last = { ...last, current_server: null, currentIp: null, currentRegion: null, blockedRegionHit: false, viaRelay: false, estimatedRegion: null, confidence: 0, candidates: [] }
  lastLeakKey = null
  deps.emit(last)
}

async function handleLine(line: string, deps: TrackerDeps): Promise<void> {
  let data: TrackerLine
  try {
    data = JSON.parse(line) as TrackerLine
  } catch {
    return
  }

  if (!data.dbdRunning) {
    if (last.dbdRunning) { lastLeakKey = null; pinged.clear() }
    last = { ...EMPTY_TRACKER, exitlagRunning: data.exitlagRunning ?? false }
    deps.emit(last)
    return
  }

  const m = await getMatcher()
  const all = (data.candidates ?? []).map((c) => {
    const regionId = m.match(c.ip)
    const estimate = regionId === RELAY_REGION ? estimateRelayRegion(c.ip) : null
    return { ip: c.ip, port: c.port, score: c.score, lastSeen: c.lastSeen, count: c.count, regionId: estimate ?? regionId, estimated: !!estimate, rawRegion: regionId }
  })

  // UDP 7770 to a regional range = GameLift ping beacon: the game measuring its latency to a region
  // (matchmaking), not the game server.
  const now = Date.now()
  for (const c of all) {
    if (c.port !== BEACON_PORT || !c.rawRegion || c.rawRegion === RELAY_REGION) continue
    if (!pinged.has(c.rawRegion)) deps.log('info', `[Tracker] Matchmaking ping to ${c.rawRegion} (GameLift beacon ${c.ip})`)
    pinged.set(c.rawRegion, now)
  }
  for (const [region, at] of pinged) if (now - at > PING_MEMORY_MS) pinged.delete(region)

  const candidates = all
    .filter((c) => !(c.port === BEACON_PORT && c.rawRegion && c.rawRegion !== RELAY_REGION))
    .map(({ rawRegion: _raw, ...c }) => c)
  const top = candidates[0] ?? null
  const currentIp = top?.ip ?? null
  const currentServer = top ? (top.ip.includes(':') ? `[${top.ip}]:${top.port}` : `${top.ip}:${top.port}`) : null
  const matched = currentIp ? m.match(currentIp) : null
  const viaRelay = matched === RELAY_REGION
  const currentRegion = viaRelay ? null : matched
  const estimatedRegion = viaRelay && currentIp ? estimateRelayRegion(currentIp) : null
  const effectiveRegion = currentRegion ?? estimatedRegion
  const blockedRegionHit = !!effectiveRegion && deps.isBlocked(effectiveRegion)
  const confidence = !top ? 0 : candidates.length === 1 ? top.score : Math.min(1, top.score + (top.score - candidates[1].score) * 0.5)
  const prev = last

  last = {
    dbdRunning: true,
    current_server: currentServer,
    currentIp,
    currentRegion,
    blockedRegionHit,
    viaRelay,
    estimatedRegion,
    pingedRegions: [...pinged.keys()].map((region) => ({ region, blocked: deps.isBlocked(region) })),
    confidence,
    candidates,
    udpPorts: data.udpPorts ?? [],
    dbdPid: data.dbdPid ?? 0,
    exitlagRunning: data.exitlagRunning ?? false,
  }

  if (currentRegion && currentRegion !== prev.currentRegion) {
    deps.log('success', `[Tracker] Game server: ${currentRegion} (${currentServer}) confidence=${Math.round(confidence * 100)}%`)
  }
  if (estimatedRegion && estimatedRegion !== prev.estimatedRegion) {
    deps.log('success', `[Tracker] Game server: probably ${estimatedRegion} (via AWS relay ${currentServer}, location estimated)`)
  }
  if (currentIp && !currentRegion && !estimatedRegion && confidence >= 0.6 && currentIp !== lastUnknownIp) {
    lastUnknownIp = currentIp
    if (viaRelay) {
      deps.log('warning', `[Tracker] Game traffic goes through an AWS GameLift relay (${currentServer}) whose location is unknown: the server region cannot be estimated`)
    } else {
      deps.log('warning', `[Tracker] Game server ${currentServer} is not in any AWS range (VPN, routing tool or non-AWS host)`)
    }
  }
  const leakKey = blockedRegionHit ? `${effectiveRegion}|${currentIp}` : null
  if (leakKey && leakKey !== lastLeakKey && confidence >= 0.6) {
    if (currentRegion) {
      deps.log('error', `[Tracker] Connected to ${currentRegion} although it is blocked. The game was probably started before the block: restart Dead by Daylight. If it persists, run Refresh IPs.`)
    } else {
      deps.log('error', `[Tracker] Matched in ${effectiveRegion} (estimated, via AWS relay) although it is blocked. Restart Dead by Daylight and check that "Block AWS relays" is enabled in Settings.`)
    }
  }
  lastLeakKey = leakKey
  if (data.exitlagRunning && !prev.exitlagRunning) {
    deps.log('warning', '[Tracker] ExitLag detected: the observed server may be a relay instead of the real game server')
  }

  deps.emit(last)
}

export function startTracker(deps: TrackerDeps): void {
  if (proc) return
  const child = spawnScript(getScriptPath('etw-tracker.ps1'), ['-ProcessNames', DBD_PROCESS_NAMES.join(',')])
  proc = child
  deps.log('info', '[Tracker] Starting...')

  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed) void handleLine(trimmed, deps)
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (d: string) => {
    for (const msg of d.split(/\r?\n/)) if (msg.trim()) deps.log('step', msg.trim())
  })
  child.stdin?.on('error', () => { /* process already gone */ })

  child.on('close', (code) => {
    if (proc === child) proc = null
    rl.close()
    last = { ...EMPTY_TRACKER }
    deps.emit(last)
    deps.log(code === 0 ? 'info' : 'warning', `[Tracker] Stopped (code=${code})`)
  })
}

/** Stops a leftover tracking session (e.g. after a power loss mid-tracking). Harmless when none exists. */
export function stopEtwSession(): Promise<void> {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return new Promise((resolve) => {
    execFile(join(root, 'System32', 'logman.exe'), ['stop', ETW_SESSION, '-ets'], { windowsHide: true, timeout: 10_000 }, () => resolve())
  })
}

/** Graceful stop ("stop" on stdin) so the ETW session is closed; force-kill + logman as a fallback. */
export function stopTracker(timeoutMs = 4000): Promise<void> {
  const child = proc
  if (!child) return Promise.resolve()
  proc = null
  return new Promise((resolve) => {
    let done = false
    const finish = async (forced: boolean): Promise<void> => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (forced) await stopEtwSession()
      resolve()
    }
    const timer = setTimeout(() => {
      child.kill()
      void finish(true)
    }, timeoutMs)
    child.once('close', () => void finish(false))
    try {
      child.stdin?.write('stop\n')
      child.stdin?.end()
    } catch {
      child.kill()
      void finish(true)
    }
  })
}

export function isTrackerRunning(): boolean {
  return proc !== null
}
