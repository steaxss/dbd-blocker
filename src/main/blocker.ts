// Region blocking service: keeps WFP filters, AWS ranges and user settings consistent.
import { app } from 'electron'
import { join } from 'path'
import { rm } from 'fs/promises'
import { countFamilies } from './aws-ranges'
import { readJson } from './fs-utils'
import { getAllRanges, getRegionRanges } from './ips'
import { REGION_IDS, isBlockableRegion, isRegionId, type RegionId } from './regions'
import { getExePath, getPermanentRegions, validateExePath } from './settings'
import { WfpError, wfpApply, wfpList, wfpPurge, type WfpRegionState, type WfpSet } from './wfp'

export type LogEmitter = (level: 'info' | 'success' | 'warning' | 'error' | 'step', message: string) => void

export interface ActionResult {
  ok: boolean
  error?: string
  code?: string
}

type Listener = (blocked: Record<string, boolean>) => void

const state = new Map<string, WfpRegionState>()
const listeners = new Set<Listener>()

export function onBlockedChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getBlockedMap(): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const id of REGION_IDS) result[id] = state.has(id)
  return result
}

export function getBlockedCount(): number {
  return state.size
}

export function isBlocked(regionId: string): boolean {
  return state.has(regionId)
}

function replaceState(regions: Record<string, WfpRegionState>): void {
  state.clear()
  for (const [id, s] of Object.entries(regions)) if (isRegionId(id) && s.filters > 0) state.set(id, s)
  const snapshot = getBlockedMap()
  for (const l of listeners) l(snapshot)
}

function errorResult(err: unknown, fallbackCode: string): ActionResult {
  if (err instanceof WfpError) return { ok: false, error: err.message, code: err.code }
  return { ok: false, error: err instanceof Error ? err.message : String(err), code: fallbackCode }
}

async function requireExe(log: LogEmitter): Promise<string | null> {
  const path = await getExePath()
  const validation = validateExePath(path)
  if (!validation.ok) {
    log('error', `DBD executable path is not configured or invalid. Open Settings and set it first. ${validation.error ?? ''}`.trim())
    return null
  }
  return path
}

function sameRanges(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((c) => set.has(c))
}

function describe(cidrs: readonly string[]): string {
  const { v4, v6 } = countFamilies(cidrs)
  return v6 > 0 ? `${v4} IPv4 + ${v6} IPv6 ranges` : `${v4} IPv4 ranges`
}

// ---------------------------------------------------------------------------------------------

export async function refreshState(): Promise<Record<string, boolean>> {
  const list = await wfpList()
  replaceState(list.regions)
  return getBlockedMap()
}

/**
 * Startup reconciliation:
 *  - removes filters left by v1.1-v1.3 (legacy sublayer) and v1.0 firewall rules, re-creating the permanent ones;
 *  - removes non-permanent blocks left behind by a crash / forced shutdown (they are meant to end with the app);
 *  - re-syncs permanent blocks with the latest AWS ranges.
 */
export async function reconcileOnStartup(log: LogEmitter): Promise<void> {
  const permanent = new Set(await getPermanentRegions())
  let list = await wfpList()

  const legacyStatePath = join(app.getPath('userData'), 'wfp-state.json')
  const legacyState = await readJson<Record<string, unknown[]>>(legacyStatePath)
  const legacyRegions = Object.entries(legacyState ?? {})
    .filter(([id, ids]) => isBlockableRegion(id) && Array.isArray(ids) && ids.length > 0)
    .map(([id]) => id)

  if (list.legacyFilters > 0 || list.legacySublayer || list.untaggedFilters > 0) {
    log('step', `Migrating ${list.legacyFilters + list.untaggedFilters} filters from a previous version...`)
    const purge = await wfpPurge()
    if (purge.legacyFirewallRules > 0) log('info', `Removed ${purge.legacyFirewallRules} legacy Windows Firewall rules (Block_DBD_*)`)
    list = await wfpList()
  }
  await rm(legacyStatePath, { force: true }).catch(() => {})

  const wanted = new Set<string>()
  for (const id of Object.keys(list.regions)) if (permanent.has(id) && isBlockableRegion(id)) wanted.add(id)
  for (const id of legacyRegions) if (permanent.has(id)) wanted.add(id)

  const stale = Object.keys(list.regions).filter((id) => !wanted.has(id))
  const ranges = await getAllRanges()
  const set: WfpSet[] = []
  for (const id of wanted) {
    const cidrs = ranges[id] ?? []
    const current = list.regions[id]
    if (cidrs.length === 0) continue
    if (current && current.persistent && sameRanges(current.cidrs, cidrs)) continue
    set.push({ region: id, cidrs, persistent: true })
  }

  if (set.length === 0 && stale.length === 0) {
    replaceState(list.regions)
    return
  }

  const exe = set.length > 0 ? await requireExe(log) : null
  if (set.length > 0 && !exe) {
    // Still clean the stale blocks, keep permanent ones as they are.
    if (stale.length > 0) replaceState((await wfpApply(null, [], stale)).regions)
    else replaceState(list.regions)
    return
  }

  const res = await wfpApply(exe, set, stale)
  replaceState(res.regions)
  if (stale.length > 0) log('info', `Removed leftover non-permanent blocks: ${stale.join(', ')}`)
  for (const s of set) log('success', `[${s.region}] Permanent block synced (${describe(s.cidrs)})`)
}

export async function blockRegion(regionId: string, log: LogEmitter): Promise<ActionResult> {
  if (!isBlockableRegion(regionId)) {
    const error = regionId === 'us-east-1'
      ? 'us-east-1 cannot be blocked: Dead by Daylight backend services run there.'
      : `Unknown region: ${String(regionId)}`
    log('error', error)
    return { ok: false, error, code: 'region_not_blockable' }
  }
  const exe = await requireExe(log)
  if (!exe) return { ok: false, error: 'DBD executable path not configured or invalid.', code: 'exe_path_invalid' }

  try {
    const cidrs = await getRegionRanges(regionId)
    if (cidrs.length === 0) {
      log('warning', `[${regionId}] No AWS ranges cached. Run Refresh IPs first.`)
      return { ok: false, error: 'No AWS ranges available. Run Refresh IPs first.', code: 'no_ranges' }
    }
    const persistent = (await getPermanentRegions()).includes(regionId)
    log('step', `[${regionId}] Creating WFP filters for ${describe(cidrs)}${persistent ? ' (permanent)' : ''}...`)
    const res = await wfpApply(exe, [{ region: regionId, cidrs, persistent }], [])
    replaceState(res.regions)
    log('success', `[${regionId}] Blocked: ${res.regions[regionId]?.filters ?? 0} filters active. Restart the game if it is running.`)
    return { ok: true }
  } catch (err) {
    log('error', `[${regionId}] Block failed: ${err instanceof Error ? err.message : String(err)}`)
    await refreshState().catch(() => {})
    return errorResult(err, 'wfp_block_failed')
  }
}

export async function unblockRegion(regionId: string, log: LogEmitter): Promise<ActionResult> {
  if (!isRegionId(regionId)) return { ok: false, error: `Unknown region: ${String(regionId)}`, code: 'unknown_region' }
  try {
    const res = await wfpApply(null, [], [regionId])
    replaceState(res.regions)
    log('success', `[${regionId}] Unblocked (${res.deleted} filters removed)`)
    return { ok: true }
  } catch (err) {
    log('error', `[${regionId}] Unblock failed: ${err instanceof Error ? err.message : String(err)}`)
    await refreshState().catch(() => {})
    return errorResult(err, 'wfp_unblock_failed')
  }
}

/** Removes every filter, sublayer and provider the app ever created (any version). */
export async function unblockAll(log: LogEmitter): Promise<ActionResult> {
  try {
    const res = await wfpPurge()
    replaceState({})
    log('success', `All regions unblocked (${res.deleted} filters removed, no WFP object left)`)
    return { ok: true }
  } catch (err) {
    log('error', `Unblock All failed: ${err instanceof Error ? err.message : String(err)}`)
    await refreshState().catch(() => {})
    return errorResult(err, 'wfp_purge_failed')
  }
}

/** Re-applies blocked regions whose AWS ranges changed (new GameLift capacity lands in new prefixes). */
export async function syncBlockedWithRanges(log: LogEmitter): Promise<string[]> {
  if (state.size === 0) return []
  const ranges = await getAllRanges()
  const permanent = new Set(await getPermanentRegions())
  const set: WfpSet[] = []
  for (const [id, current] of state) {
    const cidrs = ranges[id] ?? []
    if (cidrs.length === 0 || sameRanges(current.cidrs, cidrs)) continue
    set.push({ region: id, cidrs, persistent: permanent.has(id) })
  }
  if (set.length === 0) return []
  const exe = await requireExe(log)
  if (!exe) return []
  try {
    for (const s of set) {
      const before = state.get(s.region)?.cidrs ?? []
      const added = s.cidrs.filter((c) => !before.includes(c)).length
      const removed = before.filter((c) => !s.cidrs.includes(c)).length
      log('step', `[${s.region}] AWS ranges changed (+${added}/-${removed}): updating filters...`)
    }
    const res = await wfpApply(exe, set, [])
    replaceState(res.regions)
    log('success', `Blocked regions re-synced with the latest AWS ranges: ${set.map((s) => s.region).join(', ')}`)
    return set.map((s) => s.region)
  } catch (err) {
    log('error', `Re-sync of blocked regions failed: ${err instanceof Error ? err.message : String(err)}`)
    await refreshState().catch(() => {})
    return []
  }
}

/** Switches an active block between persistent (survives reboot) and session-only filters. */
export async function applyPersistence(regionId: RegionId, persistent: boolean, log: LogEmitter): Promise<void> {
  const current = state.get(regionId)
  if (!current || current.persistent === persistent) return
  const exe = await requireExe(log)
  if (!exe) return
  const latest = await getRegionRanges(regionId)
  const cidrs = latest.length > 0 ? latest : current.cidrs
  const res = await wfpApply(exe, [{ region: regionId, cidrs, persistent }], [])
  replaceState(res.regions)
}

/** Called on quit: non-permanent blocks end with the app. Removes the WFP provider when nothing is left. */
export async function cleanupOnExit(): Promise<void> {
  const permanent = new Set(await getPermanentRegions())
  const list = await wfpList()
  const remove = Object.keys(list.regions).filter((id) => !permanent.has(id))
  const leftovers = list.legacyFilters > 0 || list.untaggedFilters > 0 || list.legacySublayer
  if (remove.length === Object.keys(list.regions).length) {
    // Nothing permanent: full purge guarantees zero residue (provider + sublayer included).
    if (remove.length > 0 || leftovers || list.provider || list.sublayer) await wfpPurge()
  } else if (remove.length > 0) {
    await wfpApply(null, [], remove)
  }
  replaceState({})
}
