import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import {
  cleanupOnExit,
  getBlockedCount,
  getBlockedMap,
  onBlockedChange,
  reconcileOnStartup,
  unblockAll,
  type LogEmitter,
} from './blocker'
import { makeLogEmitter, registerIpcHandlers } from './ipc'
import { stopEtwSession, stopTracker } from './tracker'
import { wireUpdaterEvents } from './updater'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting: Promise<void> | null = null
let log: LogEmitter = () => {}

const isDev = !!process.env.ELECTRON_RENDERER_URL
const EXIT_CLEANUP_TIMEOUT_MS = 20_000

// Two instances would race on the same WFP objects and ETW session.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

app.on('second-instance', () => {
  mainWindow?.show()
  mainWindow?.focus()
})

function getIconPath(ext: 'png' | 'ico' = 'png'): string {
  return app.isPackaged
    ? join(process.resourcesPath, `icon.${ext}`)
    : join(app.getAppPath(), 'resources', `icon.${ext}`)
}

function blockedLabel(count: number): string {
  return count > 0 ? `${count} region${count > 1 ? 's' : ''} blocked` : 'No active blocks'
}

function refreshTray(): void {
  if (!tray) return
  const count = getBlockedCount()
  tray.setToolTip(`DBD Blocker - ${blockedLabel(count)}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: blockedLabel(count), enabled: false },
    { type: 'separator' },
    {
      label: 'Unblock All',
      enabled: count > 0,
      click: async () => {
        await unblockAll(log)
        if (mainWindow && !mainWindow.isDestroyed()) {
          for (const [id, blocked] of Object.entries(getBlockedMap())) mainWindow.webContents.send('status-change', id, blocked)
          mainWindow.webContents.send('unblock-all-done')
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { mainWindow?.show(); mainWindow?.close() } },
  ]))
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 }))
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
  refreshTray()
}

/**
 * Single exit path: stop the tracker (closes the ETW session), remove non-permanent blocks and,
 * when nothing permanent is left, the WFP provider/sublayer too. Bounded so a stuck BFE never hangs the quit.
 */
function quitWithCleanup(): Promise<void> {
  if (quitting) return quitting
  quitting = (async () => {
    const cleanup = (async () => {
      await stopTracker().catch(() => {})
      await cleanupOnExit().catch(() => {})
    })()
    await Promise.race([cleanup, new Promise((r) => setTimeout(r, EXIT_CLEANUP_TIMEOUT_MS))])
    tray?.destroy()
    tray = null
    mainWindow?.destroy()
    mainWindow = null
    app.exit(0)
  })()
  return quitting
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#09090b',
    frame: false,
    show: false,
    icon: getIconPath('ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: isDev,
    },
  })

  win.once('ready-to-show', () => win.show())

  win.on('close', async (e) => {
    if (quitting) return
    e.preventDefault()
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel', 'Quit'],
      defaultId: 1,
      cancelId: 0,
      title: 'DBD Server Blocker',
      message: 'Are you sure you want to exit?',
      detail: 'Active blocks (except permanent ones) are removed on exit. No firewall object is left behind.',
    })
    if (response === 1) void quitWithCleanup()
  })

  win.on('closed', () => { mainWindow = null })
  // Windows logoff / shutdown: best effort (non-permanent filters are not persistent and vanish on reboot anyway).
  win.on('session-end', () => { void quitWithCleanup() })

  // Only http(s) links leave the app, and they open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)
    if (!allowed) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

// Kept for compatibility with the renderer; the main process is authoritative for the count.
ipcMain.on('blocked-count-update', () => refreshTray())
ipcMain.on('win:minimize', () => mainWindow?.hide())
ipcMain.on('win:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('win:close', () => mainWindow?.close())
ipcMain.handle('win:isMaximized', () => mainWindow?.isMaximized() ?? false)

app.whenReady().then(() => {
  const win = createWindow()
  mainWindow = win
  log = makeLogEmitter(win)
  createTray()
  onBlockedChange(() => refreshTray())

  // Reconcile WFP state (legacy migration, crash leftovers, permanent re-sync) before the UI reads it.
  const ready = reconcileOnStartup(log).catch((err) => {
    log('error', `Startup firewall reconciliation failed: ${err instanceof Error ? err.message : String(err)}`)
  })
  registerIpcHandlers(win, log, ready)
  void stopEtwSession()
  wireUpdaterEvents(win)
})

// Any other quit request (auto-update install, tray, OS) goes through the same cleanup.
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  void quitWithCleanup()
})

app.on('window-all-closed', () => { /* keep running in the tray */ })
app.on('activate', () => mainWindow?.show())
