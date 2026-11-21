import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { readJson, writeJsonAtomic } from './fs-utils'
import { isBlockableRegion } from './regions'

const DEFAULT_DBD_EXE =
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dead by Daylight\\DeadByDaylight\\Binaries\\Win64\\DeadByDaylight-Win64-Shipping.exe'

const SUPPORTED_DBD_EXES = {
  'deadbydaylight-win64-shipping.exe': {
    channel: 'Steam / Epic Games',
    binaryDir: 'win64',
  },
  'deadbydaylight-wingdk-shipping.exe': {
    channel: 'Microsoft Store / Xbox app',
    binaryDir: 'wingdk',
  },
} as const

/** Process names (without .exe) the tracker watches. */
export const DBD_PROCESS_NAMES = ['DeadByDaylight-Win64-Shipping', 'DeadByDaylight-WinGDK-Shipping']

interface AppSettings {
  exePath: string
  permanentRegions: string[]
  /** Also block the AWS GameLift relays located in blocked regions (default on). */
  blockRelays: boolean
}

let cache: AppSettings | null = null

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  const path = getSettingsPath()
  const parsed = existsSync(path) ? await readJson<Partial<AppSettings>>(path) : null
  cache = {
    exePath: typeof parsed?.exePath === 'string' && parsed.exePath.trim() ? parsed.exePath : DEFAULT_DBD_EXE,
    permanentRegions: Array.isArray(parsed?.permanentRegions)
      ? [...new Set(parsed.permanentRegions.filter(isBlockableRegion))]
      : [],
    blockRelays: typeof parsed?.blockRelays === 'boolean' ? parsed.blockRelays : true,
  }
  return cache
}

async function save(): Promise<void> {
  if (!cache) return
  await writeJsonAtomic(getSettingsPath(), cache)
}

export async function getExePath(): Promise<string> {
  return (await getSettings()).exePath
}

export async function setExePath(path: string): Promise<void> {
  const s = await getSettings()
  s.exePath = path
  await save()
}

export async function getBlockRelays(): Promise<boolean> {
  return (await getSettings()).blockRelays
}

export async function setBlockRelaysSetting(enabled: boolean): Promise<void> {
  const s = await getSettings()
  s.blockRelays = enabled
  await save()
}

export async function getPermanentRegions(): Promise<string[]> {
  return [...(await getSettings()).permanentRegions]
}

export async function markPermanent(regionId: string): Promise<void> {
  if (!isBlockableRegion(regionId)) return
  const s = await getSettings()
  if (!s.permanentRegions.includes(regionId)) {
    s.permanentRegions.push(regionId)
    await save()
  }
}

export async function unmarkPermanent(regionId: string): Promise<void> {
  const s = await getSettings()
  s.permanentRegions = s.permanentRegions.filter((id) => id !== regionId)
  await save()
}

export interface ExeValidationResult {
  ok: boolean
  error?: string
  warning?: string
}

export function validateExePath(path: string): ExeValidationResult {
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, error: 'Path cannot be empty' }
  }
  if (!/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith('\\\\')) {
    return { ok: false, error: 'Path must be absolute' }
  }
  if (!path.toLowerCase().endsWith('.exe')) {
    return { ok: false, error: 'File must be an executable (.exe)' }
  }
  if (!existsSync(path)) {
    return { ok: false, error: 'File not found. Check the path and try again' }
  }
  const parts = path.split(/[/\\]+/).filter(Boolean)
  const basename = parts.at(-1) ?? ''
  const normalized = basename.toLowerCase()
  const expected = SUPPORTED_DBD_EXES[normalized as keyof typeof SUPPORTED_DBD_EXES]

  if (!expected) {
    return {
      ok: false,
      error: `Select DeadByDaylight-Win64-Shipping.exe (Steam/Epic) or DeadByDaylight-WinGDK-Shipping.exe (Microsoft Store/Xbox), not "${basename}".`
    }
  }

  const lowerParts = parts.map((part) => part.toLowerCase())
  const hasBinaries = lowerParts.includes('binaries')
  const hasExpectedDir = lowerParts.includes(expected.binaryDir)
  const hasDbdFolder = lowerParts.includes('deadbydaylight') || lowerParts.includes('dead by daylight')

  if (!hasBinaries || !hasExpectedDir || !hasDbdFolder) {
    return {
      ok: true,
      warning: `${basename} matches the ${expected.channel} build, but the folder layout looks unusual. Double-check that this is the real game executable.`
    }
  }

  return { ok: true }
}
