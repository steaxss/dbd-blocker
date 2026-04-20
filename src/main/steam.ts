import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const DBD_APP_ID = '381210'
const DBD_EXE_RELATIVE = join(
  'Dead by Daylight',
  'DeadByDaylight',
  'Binaries',
  'Win64',
  'DeadByDaylight-Win64-Shipping.exe'
)

export interface AutoDetectResult {
  found: boolean
  path?: string
  error?: string
}

function readRegistryValue(key: string, value: string): string | null {
  try {
    const output = execFileSync(
      'reg',
      ['query', key, '/v', value],
      { encoding: 'utf-8', windowsHide: true }
    )
    const match = output.match(/REG_SZ\s+(.+)/i)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

interface LibraryFolder {
  path: string
}

function parseLibraryFoldersVdf(content: string): LibraryFolder[] {
  const folders: LibraryFolder[] = []
  const pathRegex = /"path"\s+"(.+?)"/g
  let match: RegExpExecArray | null

  while ((match = pathRegex.exec(content)) !== null) {
    folders.push({ path: match[1].replace(/\\\\/g, '\\') })
  }

  return folders
}

export function autoDetectDbdExePath(): AutoDetectResult {
  const steamPath = readRegistryValue(
    'HKCU\\Software\\Valve\\Steam',
    'SteamPath'
  )

  if (!steamPath || !existsSync(steamPath)) {
    return { found: false, error: 'Steam installation not found in registry' }
  }

  const libraryFoldersVdf = join(steamPath, 'steamapps', 'libraryfolders.vdf')
  if (!existsSync(libraryFoldersVdf)) {
    const defaultPath = join(steamPath, 'steamapps', 'common', DBD_EXE_RELATIVE)
    if (existsSync(defaultPath)) {
      return { found: true, path: defaultPath }
    }
    return { found: false, error: 'Steam libraryfolders.vdf not found' }
  }

  try {
    const vdfContent = readFileSync(libraryFoldersVdf, 'utf-8')
    const folders = parseLibraryFoldersVdf(vdfContent)

    folders.unshift({ path: steamPath })

    for (const folder of folders) {
      const manifestPath = join(
        folder.path,
        'steamapps',
        `appmanifest_${DBD_APP_ID}.acf`
      )

      if (existsSync(manifestPath)) {
        const exePath = join(folder.path, 'steamapps', 'common', DBD_EXE_RELATIVE)
        if (existsSync(exePath)) {
          return { found: true, path: exePath }
        }

        return {
          found: false,
          error: `Dead by Daylight manifest found but executable missing at ${exePath}`,
        }
      }
    }

    for (const folder of folders) {
      const exePath = join(folder.path, 'steamapps', 'common', DBD_EXE_RELATIVE)
      if (existsSync(exePath)) {
        return { found: true, path: exePath }
      }
    }

    return {
      found: false,
      error: 'Dead by Daylight not found in any Steam library folder'
    }
  } catch {
    return { found: false, error: 'Failed to parse Steam library folders' }
  }
}
