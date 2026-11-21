// Thin, serialized wrapper around scripts/wfp-block.ps1. WFP itself is the source of truth:
// nothing is tracked in a side file, so the UI can never disagree with the filters really installed.
import { getScriptPath } from './paths'
import { parseJsonOutput, runScript } from './powershell'

export interface WfpRegionState {
  filters: number
  persistent: boolean
  cidrs: string[]
}

export interface WfpListResult {
  ok: true
  regions: Record<string, WfpRegionState>
  legacyFilters: number
  untaggedFilters: number
  provider: boolean
  sublayer: boolean
  legacySublayer: boolean
}

export interface WfpApplyResult {
  ok: true
  created: number
  deleted: number
  regions: Record<string, WfpRegionState>
}

export interface WfpPurgeResult {
  ok: true
  deleted: number
  legacyFilters: number
  legacyFirewallRules: number
}

export interface WfpSet {
  region: string
  cidrs: string[]
  persistent: boolean
}

export class WfpError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

let queue: Promise<unknown> = Promise.resolve()

/** Runs WFP operations one at a time (UI clicks, tray actions, background resyncs, shutdown). */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

async function call<T>(action: 'list' | 'apply' | 'purge' | 'drops', payload?: unknown, extraArgs: string[] = []): Promise<T> {
  const res = await runScript(getScriptPath('wfp-block.ps1'), ['-Action', action, ...extraArgs], {
    stdin: payload === undefined ? '' : JSON.stringify(payload),
    timeoutMs: 120_000,
  })
  const parsed = parseJsonOutput<{ ok: boolean; error?: string }>(res.stdout)
  if (res.timedOut) throw new WfpError(`WFP ${action} timed out`, 'wfp_timeout')
  if (!parsed) {
    const detail = res.stderr || res.stdout || `exit code ${res.code}`
    throw new WfpError(`WFP ${action} failed: ${detail}`, 'wfp_script_failed')
  }
  if (!parsed.ok) throw new WfpError(parsed.error ?? `WFP ${action} failed`, `wfp_${action}_failed`)
  return parsed as T
}

export function wfpList(): Promise<WfpListResult> {
  return serialized(() => call<WfpListResult>('list'))
}

export function wfpApply(processPath: string | null, set: WfpSet[], remove: string[]): Promise<WfpApplyResult> {
  return serialized(() => call<WfpApplyResult>('apply', { processPath: processPath ?? '', set, remove }))
}

export interface WfpDropEvent {
  time: string
  region: string
  filterId: string
  remote: string
  port: number
  localPort: number
}

export interface WfpDropsResult {
  ok: true
  /** false when Windows did not produce the net event log (collection disabled). */
  available: boolean
  events: WfpDropEvent[]
}

/** Packets dropped by the app filters in the last `seconds` (read-only, not serialized with writes). */
export async function wfpDrops(seconds: number): Promise<WfpDropsResult> {
  const res = await call<WfpDropsResult>('drops', undefined, ['-Seconds', String(Math.round(seconds))])
  return { ...res, events: Array.isArray(res.events) ? res.events : res.events ? [res.events] : [] }
}

export function wfpPurge(): Promise<WfpPurgeResult> {
  return serialized(() => call<WfpPurgeResult>('purge'))
}
