import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import {
  isBlocked,
  getBlockedMap,
  wfpBlock,
  wfpUnblock,
  wfpUnblockMany,
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

export async function getBlockedRegions(regionIds: string[]): Promise<Record<string, boolean>> {
  const all = await getBlockedMap()
  const result: Record<string, boolean> = {}
  for (const id of regionIds) result[id] = all[id] ?? false
  return result
}

// ── Firewall health check — runs wfp-prereq.ps1 ───────────────────────────────

export function checkFirewallHealth(
  log: LogEmitter,
  scriptPath: string
): Promise<{ healthy: boolean; issue?: string; cause?: 'wfp-broken' | 'third-party' }> {
  return new Promise((resolve) => {
    log('step', '[Health] Running WFP direct API test...')

    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const ps64 = `${sysRoot}\\SysNative\\WindowsPowerShell\\v1.0\\powershell.exe`
    const psExe = require('fs').existsSync(ps64) ? ps64 : 'powershell'

    let resultLine: string | null = null

    const child = spawn(psExe, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
    ], { windowsHide: true })

    const parseLine = (line: string) => {
      const t = line.trim()
      if (!t) return
      const level =
        t.startsWith('FAIL') || t.includes('RESULT: FAIL') ? 'error' :
        t.includes('RESULT: PASS') || t.startsWith('OK') ? 'success' :
        t.startsWith('[') ? 'step' :
        'info'
      log(level, '[Health] ' + t)
      if (t.startsWith('RESULT:')) resultLine = t
    }

    child.stdout?.on('data', (d: Buffer) => d.toString().split('\n').forEach(parseLine))
    child.stderr?.on('data', (d: Buffer) => d.toString().split('\n').forEach(l => {
      if (l.trim()) log('error', '[Health] ' + l.trim())
    }))

    child.on('close', (code) => {
      if (resultLine?.includes('RESULT: PASS')) {
        log('success', '[Health] WFP direct API is functional')
        resolve({ healthy: true })
      } else if (resultLine?.includes('RESULT: FAIL')) {
        log('warning', '[Health] WFP API unavailable or broken')
        resolve({
          healthy: false,
          cause: 'wfp-broken',
          issue: 'WFP direct API test failed — region blocking may not work correctly.'
        })
      } else {
        log('error', `[Health] Script failed (exit ${code})`)
        resolve({
          healthy: false,
          cause: 'wfp-broken',
          issue: 'WFP prereq script failed — check that the app is running as Administrator.'
        })
      }
    })
  })
}

// ── Firewall repair (unchanged) ───────────────────────────────────────────────

export interface RepairStepUpdate {
  id: string
  status: 'running' | 'done' | 'error' | 'warning'
  detail?: string
}

export interface RepairResult {
  ok: boolean
  backupPath?: string
  needsReboot: boolean
  error?: string
}

function runProcess(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true, shell: false })
    proc.on('close', (code) => resolve(code ?? 0))
    proc.on('error', () => resolve(1))
  })
}

export async function repairFirewall(
  log: LogEmitter,
  onStep: (update: RepairStepUpdate) => void,
  userData: string
): Promise<RepairResult> {
  const backupPath = join(userData, `firewall_backup_${Date.now()}.reg`)
  let needsReboot = false

  onStep({ id: 'backup', status: 'running' })
  log('step', '[Repair 1/5] Backing up current firewall rules...')
  try {
    await execFileAsync('reg', [
      'export',
      'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules',
      backupPath, '/y'
    ], { timeout: 30_000 })
    onStep({ id: 'backup', status: 'done', detail: backupPath })
    log('success', `[Repair 1/5] Backup saved: ${backupPath}`)
  } catch (err) {
    onStep({ id: 'backup', status: 'error', detail: String(err) })
    log('error', `[Repair 1/5] Backup failed: ${err}`)
    return { ok: false, needsReboot: false, error: 'Backup failed — aborting to avoid data loss' }
  }

  onStep({ id: 'sfc', status: 'running' })
  log('step', '[Repair 2/5] Running sfc /scannow — this may take 15-30 minutes...')
  const sfcCode = await runProcess('sfc', ['/scannow'])
  needsReboot = true
  if (sfcCode === 0 || sfcCode === 1) {
    onStep({ id: 'sfc', status: 'done', detail: sfcCode === 1 ? 'Corrupted files repaired' : 'No integrity violations found' })
    log('success', `[Repair 2/5] sfc completed (exit ${sfcCode})`)
  } else {
    onStep({ id: 'sfc', status: 'warning', detail: `Exit code ${sfcCode} — some files could not be repaired` })
    log('warning', `[Repair 2/5] sfc exited with code ${sfcCode}`)
  }

  onStep({ id: 'dism', status: 'running' })
  log('step', '[Repair 3/5] Running DISM /RestoreHealth — this may take 15-30 minutes...')
  const dismCode = await runProcess('DISM', ['/Online', '/Cleanup-Image', '/RestoreHealth'])
  if (dismCode === 0) {
    onStep({ id: 'dism', status: 'done', detail: 'Component store repaired' })
    log('success', '[Repair 3/5] DISM completed successfully')
  } else {
    onStep({ id: 'dism', status: 'warning', detail: `Exit code ${dismCode}` })
    log('warning', `[Repair 3/5] DISM exited with code ${dismCode}`)
  }

  onStep({ id: 'reset', status: 'running' })
  log('step', '[Repair 4/5] Resetting Windows Firewall policy store...')
  try {
    await execFileAsync('netsh', ['advfirewall', 'reset'], { timeout: 30_000 })
    onStep({ id: 'reset', status: 'done' })
    log('success', '[Repair 4/5] Firewall reset complete')
  } catch (err) {
    onStep({ id: 'reset', status: 'error', detail: String(err) })
    log('error', `[Repair 4/5] Reset failed: ${err}`)
    return { ok: false, backupPath, needsReboot, error: 'Firewall reset failed — backup preserved at: ' + backupPath }
  }

  onStep({ id: 'restore', status: 'running' })
  log('step', '[Repair 5/5] Restoring firewall rules from backup...')
  try {
    await execFileAsync('reg', ['import', backupPath], { timeout: 60_000 })
    onStep({ id: 'restore', status: 'done' })
    log('success', '[Repair 5/5] Rules restored successfully')
  } catch (err) {
    onStep({ id: 'restore', status: 'error', detail: String(err) })
    log('error', `[Repair 5/5] Restore failed: ${err}`)
    return { ok: false, backupPath, needsReboot, error: 'Rules restore failed — backup at: ' + backupPath }
  }

  return { ok: true, backupPath, needsReboot }
}
