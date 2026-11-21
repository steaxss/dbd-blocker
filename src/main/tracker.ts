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
  confidence: number
  candidates: Array<{ ip: string; port: number; score: number; lastSeen: number; count: number; regionId: string | null; estimated?: boolean }>
  udpPorts: number[]
  dbdPid: number
  exitlagRunning: boolean
}

export const EMPTY_TRACKER: TrackerResult = {
  dbdRunning: false, current_server: null, currentIp: null, currentRegion: null, blockedRegionHit: false, viaRelay: false, estimatedRegion: null,
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
    if (last.dbdRunning) lastLeakKey = null
    last = { ...EMPTY_TRACKER, exitlagRunning: data.exitlagRunning ?? false }
    deps.emit(last)
    return
  }

  const m = await getMatcher()
  const candidates = (data.candidates ?? []).map((c) => {
    const regionId = m.match(c.ip)
    const estimate = regionId === RELAY_REGION ? estimateRelayRegion(c.ip) : null
    return { ip: c.ip, port: c.port, score: c.score, lastSeen: c.lastSeen, count: c.count, regionId: estimate ?? regionId, estimated: !!estimate }
  })
  const currentIp = data.currentIp ?? null
  const matched = currentIp ? m.match(currentIp) : null
  const viaRelay = matched === RELAY_REGION
  const currentRegion = viaRelay ? null : matched
  const estimatedRegion = viaRelay && currentIp ? estimateRelayRegion(currentIp) : null
  const effectiveRegion = currentRegion ?? estimatedRegion
  const blockedRegionHit = !!effectiveRegion && deps.isBlocked(effectiveRegion)
  const prev = last

  last = {
    dbdRunning: true,
    current_server: data.current_server ?? null,
    currentIp,
    currentRegion,
    blockedRegionHit,
    viaRelay,
    estimatedRegion,
    confidence: data.confidence ?? 0,
    candidates,
    udpPorts: data.udpPorts ?? [],
    dbdPid: data.dbdPid ?? 0,
    exitlagRunning: data.exitlagRunning ?? false,
  }

  if (currentRegion && currentRegion !== prev.currentRegion) {
    deps.log('success', `[Tracker] Game server: ${currentRegion} (${data.current_server}) confidence=${Math.round(last.confidence * 100)}%`)
  }
  if (estimatedRegion && estimatedRegion !== prev.estimatedRegion) {
    deps.log('success', `[Tracker] Game server: probably ${estimatedRegion} (via AWS relay ${data.current_server}, location estimated)`)
  }
  if (currentIp && !currentRegion && !estimatedRegion && last.confidence >= 0.6 && currentIp !== lastUnknownIp) {
    lastUnknownIp = currentIp
    if (viaRelay) {
      deps.log('warning', `[Tracker] Game traffic goes through an AWS GameLift relay (${data.current_server}, AWS range "GLOBAL"): the real server region cannot be read from this IP`)
    } else {
      deps.log('warning', `[Tracker] Game server ${data.current_server} is not in any AWS range (VPN, routing tool or non-AWS host)`)
    }
  }
  const leakKey = blockedRegionHit ? `${effectiveRegion}|${currentIp}` : null
  if (leakKey && leakKey !== lastLeakKey && last.confidence >= 0.6) {
    if (currentRegion) {
      deps.log('error', `[Tracker] Connected to ${currentRegion} although it is blocked. The game was probably started before the block: restart Dead by Daylight. If it persists, run Refresh IPs.`)
    } else {
      deps.log('error', `[Tracker] Matched in ${effectiveRegion} (estimated) although it is blocked: the match goes through an AWS GameLift relay, which region blocks cannot cover.`)
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
