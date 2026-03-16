import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import {
  isBlocked,
  getBlockedMap,
  wfpBlock,
  wfpUnblock,
  wfpUnblockMany,
  wfpPurgeAll,
} from './wfp'

export type { LogEmitter } from './wfp'

const execFileAsync = promisify(execFile)

// ── PowerShell helper (still needed for UDP monitor in ipc.ts) ────────────────

export async function ps(command: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: 30_000 }
    )
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: e.stdout?.trim() ?? '',
      stderr: e.stderr?.trim() ?? e.message ?? String(err)
    }
  }
}

// ── WFP-backed firewall operations ────────────────────────────────────────────

export async function ruleExists(regionId: string): Promise<boolean> {
  return isBlocked(regionId)
}

export async function blockRegion(
  regionId: string,
  cidrs: string[],
  log: LogEmitter
): Promise<{ ok: boolean; error?: string }> {
  return wfpBlock(regionId, cidrs, log)
}

export async function unblockRegion(
  regionId: string,
  log: LogEmitter
): Promise<{ ok: boolean; error?: string }> {
  return wfpUnblock(regionId, log)
}

export async function unblockAll(regionIds: string[], log: LogEmitter): Promise<void> {
  return wfpUnblockMany(regionIds, log)
}

export async function purgeAllWfp(log: LogEmitter): Promise<void> {
  return wfpPurgeAll(log)
}

export function checkFirewallHealth(log: LogEmitter, scriptPath: string): void {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const ps64 = `${sysRoot}\\SysNative\\WindowsPowerShell\\v1.0\\powershell.exe`
  const psExe = require('fs').existsSync(ps64) ? ps64 : 'powershell'

  const child = spawn(psExe, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
  ], { windowsHide: true })

  const parseLine = (line: string) => {
    const t = line.trim()
    if (!t) return
    const level =
      t.includes('RESULT: FAIL') || t.startsWith('FAIL') ? 'warning' :
      t.includes('RESULT: PASS') || t.startsWith('OK')   ? 'success' :
      'step'
    log(level, '[WFP] ' + t)
  }

  child.stdout?.on('data', (d: Buffer) => d.toString().split('\n').forEach(parseLine))
  child.stderr?.on('data', (d: Buffer) => d.toString().split('\n').forEach(l => {
    if (l.trim()) log('warning', '[WFP] ' + l.trim())
  }))
}

export async function getBlockedRegions(regionIds: string[]): Promise<Record<string, boolean>> {
  const all = await getBlockedMap()
  const result: Record<string, boolean> = {}
  for (const id of regionIds) result[id] = all[id] ?? false
  return result
}
