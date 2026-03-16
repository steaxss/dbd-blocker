/**
 * WFP (Windows Filtering Platform) direct API manager.
 *
 * Delegates to scripts/wfp-block.ps1 (embedded C# via Add-Type).
 * Maintains a state map (regionId → WFP filter IDs) persisted to
 * userData/wfp-state.json so filters can be cleaned up across restarts.
 *
 * All WFP filters are created with FWPM_FILTER_FLAG_PERSISTENT so they
 * survive engine-handle close and OS reboots.
 */

import { spawn } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
export type LogEmitter = (level: string, message: string) => void

// ── State ─────────────────────────────────────────────────────────────────────

// regionId → WFP filter IDs (stored as strings: ulong can exceed JS safe integer)
const blockedState = new Map<string, string[]>()
let stateLoaded = false

function statePath(): string {
  return join(app.getPath('userData'), 'wfp-state.json')
}

async function loadState(): Promise<void> {
  if (stateLoaded) return
  stateLoaded = true
  try {
    const path = statePath()
    if (!existsSync(path)) return
    const raw = await readFile(path, 'utf-8')
    const data = JSON.parse(raw) as Record<string, string[]>
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && v.length > 0) blockedState.set(k, v)
    }
  } catch {
    // corrupt/missing state — start fresh
  }
}

async function saveState(): Promise<void> {
  try {
    const data: Record<string, string[]> = {}
    for (const [k, v] of blockedState) data[k] = v
    await writeFile(statePath(), JSON.stringify(data), 'utf-8')
  } catch { /* ignore */ }
}

// ── PowerShell subprocess ─────────────────────────────────────────────────────

function getPsExe(): string {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const ps64 = `${sysRoot}\\SysNative\\WindowsPowerShell\\v1.0\\powershell.exe`
  return existsSync(ps64) ? ps64 : 'powershell'
}

function getScriptPath(): string {
  return join(app.getAppPath(), 'scripts', 'wfp-block.ps1')
}

function runScript(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      getPsExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', getScriptPath(), ...args],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }))
    child.on('error', (err) => resolve({ ok: false, stdout: '', stderr: String(err) }))
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function isBlocked(regionId: string): Promise<boolean> {
  await loadState()
  return blockedState.has(regionId)
}

export async function getBlockedMap(): Promise<Record<string, boolean>> {
  await loadState()
  const result: Record<string, boolean> = {}
  for (const [k, v] of blockedState) {
    if (v.length > 0) result[k] = true
  }
  return result
}

export async function wfpBlock(
  regionId: string,
  cidrs: string[],
  log: LogEmitter
): Promise<{ ok: boolean; error?: string }> {
  await loadState()

  // Remove any stale filters for this region first
  if (blockedState.has(regionId)) {
    const old = blockedState.get(regionId)!
    if (old.length > 0) {
      log('step', `[${regionId}] [1/3] Cleaning up ${old.length} stale WFP filters...`)
      await runScript(['-Action', 'unblock', '-FilterIdsJson', JSON.stringify(old)])
    }
    blockedState.delete(regionId)
    await saveState()
  } else {
    log('step', `[${regionId}] [1/3] OK (no stale filters)`)
  }

  log('step', `[${regionId}] [2/3] Creating ${cidrs.length} WFP block filters...`)

  const res = await runScript([
    '-Action', 'block',
    '-CidrsJson', JSON.stringify(cidrs)
  ])

  if (!res.ok || !res.stdout.startsWith('[')) {
    const err = res.stderr || res.stdout || 'wfp-block.ps1 failed'
    log('error', `[${regionId}] [2/3] FAILED — ${err}`)
    return { ok: false, error: err }
  }

  let filterIds: string[]
  try {
    filterIds = JSON.parse(res.stdout) as string[]
  } catch {
    const err = `Cannot parse filter IDs: ${res.stdout}`
    log('error', `[${regionId}] [2/3] FAILED — ${err}`)
    return { ok: false, error: err }
  }

  blockedState.set(regionId, filterIds.map(String))
  await saveState()

  log('step', `[${regionId}] [3/3] Verifying WFP filter is active...`)
  const spotCheck = await runScript(['-Action', 'check', '-FilterIdsJson', JSON.stringify([filterIds[0]])])
  if (spotCheck.stdout.trim() === 'true') {
    const partial = filterIds.length !== cidrs.length ? ` (partial: ${filterIds.length}/${cidrs.length} CIDRs)` : ''
    log('success', `[${regionId}] Block confirmed — ${filterIds.length} WFP filter${filterIds.length !== 1 ? 's' : ''} active${partial}. Restart your game for changes to take effect.`)
  } else {
    log('warning', `[${regionId}] WFP filters created but verification failed — ensure the app runs as Administrator.`)
  }
  return { ok: true }
}

export async function wfpUnblock(
  regionId: string,
  log: LogEmitter
): Promise<{ ok: boolean; error?: string }> {
  await loadState()

  const filterIds = blockedState.get(regionId)
  if (!filterIds || filterIds.length === 0) {
    log('info', `[${regionId}] Already unblocked`)
    return { ok: true }
  }

  log('step', `[${regionId}] [1/2] Deleting ${filterIds.length} WFP filters...`)

  const res = await runScript([
    '-Action', 'unblock',
    '-FilterIdsJson', JSON.stringify(filterIds)
  ])

  if (!res.ok) {
    const err = res.stderr || 'wfp-block.ps1 unblock failed'
    log('error', `[${regionId}] [1/2] FAILED — ${err}`)
    return { ok: false, error: err }
  }

  const psResult = res.stdout.trim()
  if (psResult === 'false') {
    log('warning', `[${regionId}] [1/2] WFP delete returned false — some filters may remain`)
  }

  blockedState.delete(regionId)
  await saveState()

  log('step', `[${regionId}] [1/2] OK (WFP: ${psResult})`)
  log('success', `[${regionId}] UNBLOCKED`)
  return { ok: true }
}

export async function wfpPurgeAll(log: LogEmitter): Promise<void> {
  log('step', 'WFP purge — enumerating orphaned filters...')
  const res = await runScript(['-Action', 'purge'])
  if (!res.ok) {
    log('warning', `WFP purge script error: ${res.stderr || res.stdout}`)
    return
  }
  const count = parseInt(res.stdout.trim(), 10)
  blockedState.clear()
  await saveState()
  if (count === -1) {
    log('warning', 'WFP purge: FwpmFilterCreateEnumHandle0 failed — run as Administrator')
  } else if (count === 0) {
    log('info', 'WFP purge: no orphaned filters found')
  } else {
    log('success', `WFP purge: ${count} orphaned filter${count !== 1 ? 's' : ''} removed`)
  }
}

export async function wfpUnblockMany(regionIds: string[], log: LogEmitter): Promise<void> {
  await loadState()

  const toDelete: string[] = []
  const toRemove: string[] = []

  for (const id of regionIds) {
    const ids = blockedState.get(id)
    if (ids && ids.length > 0) {
      toDelete.push(...ids)
      toRemove.push(id)
    }
  }

  if (toDelete.length === 0) return

  log('info', `WFP cleanup — deleting ${toDelete.length} filters for ${toRemove.length} regions...`)

  const res = await runScript([
    '-Action', 'unblock',
    '-FilterIdsJson', JSON.stringify(toDelete)
  ])

  if (!res.ok) {
    log('warning', `WFP cleanup partial failure: ${res.stderr}`)
  }

  for (const id of toRemove) blockedState.delete(id)
  await saveState()

  log('info', 'WFP cleanup complete')
}
