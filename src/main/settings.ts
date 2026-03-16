import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'

const DEFAULT_DBD_EXE =
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dead by Daylight\\DeadByDaylight\\Binaries\\Win64\\DeadByDaylight-Win64-Shipping.exe'

interface AppSettings {
  exePath: string
  permanentRegions: string[]
  exclusiveRegion: string | null
}

let cache: AppSettings | null = null

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  const path = getSettingsPath()
  if (!existsSync(path)) {
    cache = { exePath: DEFAULT_DBD_EXE, permanentRegions: [], exclusiveRegion: null }
    return cache
  }
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    cache = {
      exePath: typeof parsed.exePath === 'string' ? parsed.exePath : DEFAULT_DBD_EXE,
      permanentRegions: Array.isArray(parsed.permanentRegions) ? parsed.permanentRegions : [],
      exclusiveRegion: typeof parsed.exclusiveRegion === 'string' ? parsed.exclusiveRegion : null
    }
    return cache
  } catch {
    cache = { exePath: DEFAULT_DBD_EXE, permanentRegions: [], exclusiveRegion: null }
    return cache
  }
}

async function save(): Promise<void> {
  if (!cache) return
  await writeFile(getSettingsPath(), JSON.stringify(cache, null, 2), 'utf-8')
}

export async function getExePath(): Promise<string> {
  return (await getSettings()).exePath
}

export async function setExePath(path: string): Promise<void> {
  const s = await getSettings()
  s.exePath = path
  await save()
}

export async function getPermanentRegions(): Promise<string[]> {
  return (await getSettings()).permanentRegions
}

export async function markPermanent(regionId: string): Promise<void> {
  const s = await getSettings()
  if (!s.permanentRegions.includes(regionId)) {
    s.permanentRegions.push(regionId)
    await save()
  }
}

export async function unmarkPermanent(regionId: string): Promise<void> {
  const s = await getSettings()
  s.permanentRegions = s.permanentRegions.filter(id => id !== regionId)
  await save()
}

export async function getExclusiveRegion(): Promise<string | null> {
  return (await getSettings()).exclusiveRegion ?? null
}

export async function setExclusiveRegion(regionId: string | null): Promise<void> {
  const s = await getSettings()
  s.exclusiveRegion = regionId
  await save()
}

export interface ExeValidationResult {
  ok: boolean
  error?: string
  warning?: string
}

export function validateExePath(path: string): ExeValidationResult {
  if (!path || !path.trim()) {
    return { ok: false, error: 'Path cannot be empty' }
  }
  if (!path.toLowerCase().endsWith('.exe')) {
    return { ok: false, error: 'File must be an executable (.exe)' }
  }
  if (!existsSync(path)) {
    return { ok: false, error: 'File not found — check the path and try again' }
  }
  const basename = path.split(/[/\\]/).pop() ?? ''
  if (basename.toLowerCase() !== 'deadbydaylight-win64-shipping.exe') {
    return {
      ok: true,
      warning: `Unexpected filename "${basename}" — make sure this is the correct DBD executable`
    }
  }
  return { ok: true }
}
