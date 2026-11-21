import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

export interface ScriptResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Absolute path to 64-bit Windows PowerShell 5.1.
 * Never resolved through PATH: the app runs elevated, a PATH lookup could be hijacked.
 * From a 32-bit process System32 is redirected, SysNative reaches the 64-bit binaries.
 */
export function powershellExe(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const sysnative = join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (process.arch !== 'x64' && process.arch !== 'arm64' && existsSync(sysnative)) return sysnative
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const BASE_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

export function spawnScript(scriptPath: string, args: string[] = []): ChildProcess {
  return spawn(powershellExe(), [...BASE_ARGS, scriptPath, ...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

export function runScript(
  scriptPath: string,
  args: string[] = [],
  options: { stdin?: string; timeoutMs?: number } = {}
): Promise<ScriptResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  return new Promise((resolve) => {
    const child = spawnScript(scriptPath, args)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { stdout += d })
    child.stderr?.on('data', (d: string) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr || String(err), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut })
    })

    child.stdin?.on('error', () => { /* child exited before reading stdin */ })
    child.stdin?.end(options.stdin ?? '')
  })
}

/** Parses the last JSON object line printed by a script. */
export function parseJsonOutput<T>(stdout: string): T | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    try {
      return JSON.parse(lines[i]) as T
    } catch {
      return null
    }
  }
  return null
}
