import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import {
  type LogEmitter,
  isBlocked,
  getBlockedMap,
  wfpBlock,
  wfpUnblock,
  wfpUnblockMany,
  wfpPurgeAll,
} from './wfp'

export interface FirewallActionResult {
  ok: boolean
  error?: string
  code?: string
}

export interface FirewallHealthResult {
  ok: boolean
  details: string[]
  error?: string
}

const execFileAsync = promisify(execFile)

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

export async function ruleExists(regionId: string): Promise<boolean> {
  return isBlocked(regionId)
}

export async function blockRegion(
  regionId: string,
  cidrs: string[],
  log: LogEmitter,
  processPath?: string
): Promise<FirewallActionResult> {
  return wfpBlock(regionId, cidrs, log, processPath)
}

export async function unblockRegion(
  regionId: string,
  log: LogEmitter
): Promise<FirewallActionResult> {
  return wfpUnblock(regionId, log)
}

export async function unblockAll(regionIds: string[], log: LogEmitter): Promise<void> {
  return wfpUnblockMany(regionIds, log)
}

export async function purgeAllWfp(log: LogEmitter): Promise<void> {
  return wfpPurgeAll(log)
}

export function checkFirewallHealth(log: LogEmitter, scriptPath: string): Promise<FirewallHealthResult> {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const ps64 = `${sysRoot}\\SysNative\\WindowsPowerShell\\v1.0\\powershell.exe`
  const psExe = require('fs').existsSync(ps64) ? ps64 : 'powershell'

  return new Promise((resolve) => {
    const child = spawn(psExe, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
    ], { windowsHide: true })

    const details: string[] = []
    let sawPass = false
    let sawFail = false

    const parseLine = (line: string, fromStderr = false) => {
      const t = line.trim()
      if (!t) return
      details.push(t)
      const level =
        t.includes('RESULT: FAIL') || t.startsWith('FAIL') || fromStderr ? 'warning' :
        t.includes('RESULT: PASS') || t.startsWith('OK') ? 'success' :
        'step'
      if (t.includes('RESULT: PASS')) sawPass = true
      if (t.includes('RESULT: FAIL') || t.startsWith('FAIL')) sawFail = true
      log(level, '[WFP] ' + t)
    }

    child.stdout?.on('data', (d: Buffer) => d.toString().split('\n').forEach((line) => parseLine(line)))
    child.stderr?.on('data', (d: Buffer) => d.toString().split('\n').forEach((line) => parseLine(line, true)))

    child.on('close', (code) => {
      const ok = code === 0 && sawPass && !sawFail
      resolve({
        ok,
        details,
        ...(ok ? {} : { error: details.at(-1) ?? `Health check failed (code=${code})` }),
      })
    })

    child.on('error', (err) => {
      const message = String(err)
      log('warning', '[WFP] ' + message)
      resolve({ ok: false, details, error: message })
    })
  })
}

export async function getBlockedRegions(regionIds: string[]): Promise<Record<string, boolean>> {
  const all = await getBlockedMap()
  const result: Record<string, boolean> = {}
  for (const id of regionIds) result[id] = all[id] ?? false
  return result
}
