import { app } from 'electron'
import { join } from 'path'

export function getScriptsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'scripts')
    : join(app.getAppPath(), 'scripts')
}

export function getScriptPath(name: string): string {
  return join(getScriptsDir(), name)
}
