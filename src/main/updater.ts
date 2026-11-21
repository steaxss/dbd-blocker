import { app, type BrowserWindow } from 'electron'
import * as electronUpdater from 'electron-updater'
import type { AppUpdater } from 'electron-updater'

let updater: AppUpdater | null = null

function getUpdater(): AppUpdater {
  if (updater) return updater
  // electron-updater is CommonJS: the named export is not always present through the ESM interop layer.
  const mod = electronUpdater as unknown as { autoUpdater?: AppUpdater; default?: { autoUpdater: AppUpdater } }
  const instance = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!instance) throw new Error('electron-updater is unavailable')
  instance.autoDownload = false
  instance.autoInstallOnAppQuit = false
  updater = instance
  return instance
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export function wireUpdaterEvents(win: BrowserWindow): void {
  if (!app.isPackaged) return
  const u = getUpdater()
  u.on('download-progress', (progress) => {
    if (!win.isDestroyed()) win.webContents.send('update-download-progress', progress.percent)
  })
  u.on('update-downloaded', () => {
    if (!win.isDestroyed()) win.webContents.send('update-downloaded')
  })
}

export async function checkForUpdate(): Promise<{ available: boolean; version: string; url: string }> {
  const current = app.getVersion()
  if (!app.isPackaged) return { available: false, version: current, url: '' }
  try {
    const result = await getUpdater().checkForUpdates()
    const latest = result?.updateInfo?.version
    if (!latest) return { available: false, version: current, url: '' }
    return { available: compareVersions(latest, current) > 0, version: latest, url: '' }
  } catch {
    return { available: false, version: current, url: '' }
  }
}

export async function downloadUpdate(): Promise<void> {
  await getUpdater().downloadUpdate()
}

export function installUpdate(): void {
  getUpdater().quitAndInstall(false, true)
}
