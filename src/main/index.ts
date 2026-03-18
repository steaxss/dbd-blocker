import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'
import { unblockAll, getBlockedRegions } from './firewall'
import { registerIpcHandlers } from './ipc'

// Shared region IDs — imported by ipc.ts
export const REGION_IDS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1',
  'eu-central-1', 'eu-west-1', 'eu-west-2',
  'ap-south-1', 'ap-east-1', 'ap-northeast-1', 'ap-northeast-2',
  'ap-southeast-1', 'ap-southeast-2',
  'sa-east-1'
]

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let blockedCount = 0

const isDev = !!process.env.ELECTRON_RENDERER_URL

// ---------------------------------------------------------------------------
// Log emitter (before window exists)
// ---------------------------------------------------------------------------

function silentLog(_level: string, _message: string): void {
  // Used before window is ready
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function updateTrayTooltip(): void {
  if (!tray) return
  tray.setToolTip(
    blockedCount > 0
      ? `DBD Blocker — ${blockedCount} region${blockedCount > 1 ? 's' : ''} blocked`
      : 'DBD Blocker — No active blocks'
  )
}

function buildTrayMenu(): void {
  if (!tray) return
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    {
      label: blockedCount > 0
        ? `${blockedCount} region${blockedCount > 1 ? 's' : ''} blocked`
        : 'No active blocks',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Unblock All',
      enabled: blockedCount > 0,
      click: async () => {
        await unblockAll(REGION_IDS, silentLog)
        blockedCount = 0
        buildTrayMenu()
        updateTrayTooltip()
        mainWindow?.webContents.send('unblock-all-done')
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        // Show the main window then trigger close (which has the confirmation dialog)
        mainWindow?.show()
        mainWindow?.close()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
}

function getIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(process.cwd(), 'resources/icon.png')
}

function createTray(): void {
  const icon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('DBD Blocker')
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  buildTrayMenu()
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#09090b',
    frame: false,
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDev,
    }
  })

  // X button or Alt+F4 → show quit confirmation dialog
  mainWindow.on('close', async (e) => {
    if (isQuitting) return
    e.preventDefault()

    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      buttons: ['Cancel', 'Quit'],
      defaultId: 1,
      cancelId: 0,
      title: 'DBD Server Blocker',
      message: 'Are you sure you want to exit?',
      detail: 'Active firewall rules (excluding permanent ones) will be removed on exit.',
    })

    if (response === 1) {
      isQuitting = true
      const { getPermanentRegions } = await import('./settings')
      const permanent = await getPermanentRegions()
      const protected_ = new Set(permanent)
      const toUnblock = REGION_IDS.filter(id => !protected_.has(id))
      await unblockAll(toUnblock, silentLog)
      app.quit()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// IPC for tray sync + window controls
// ---------------------------------------------------------------------------

ipcMain.on('blocked-count-update', (_, count: number) => {
  blockedCount = count
  buildTrayMenu()
  updateTrayTooltip()
})

// Minimize → hide to tray directly
ipcMain.on('win:minimize', () => mainWindow?.hide())

ipcMain.on('win:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})

ipcMain.on('win:close', () => {
  // Trigger the close event handler (which shows the confirmation dialog)
  mainWindow?.close()
})

ipcMain.handle('win:isMaximized', () => mainWindow?.isMaximized() ?? false)

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  createWindow()
  createTray()

  if (mainWindow) {
    registerIpcHandlers(mainWindow)

    // Set up electron-updater event forwarding to renderer
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('download-progress', (progress) => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow!.webContents.send('update-download-progress', progress.percent)
      }
    })
    autoUpdater.on('update-downloaded', () => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow!.webContents.send('update-downloaded')
      }
    })
  }

  const status = await getBlockedRegions(REGION_IDS)
  blockedCount = Object.values(status).filter(Boolean).length
  buildTrayMenu()
  updateTrayTooltip()
})

app.on('before-quit', async () => {
  isQuitting = true
  const { getPermanentRegions } = await import('./settings')
  const permanent = await getPermanentRegions()
  const protected_ = new Set(permanent)
  const toUnblock = REGION_IDS.filter(id => !protected_.has(id))
  await unblockAll(toUnblock, silentLog)
})

app.on('window-all-closed', () => {
  // Keep alive in tray on Windows
})

app.on('activate', () => {
  mainWindow?.show()
})
