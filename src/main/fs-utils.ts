import { randomBytes } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'

/** Writes a JSON file atomically (temp file + rename) so a crash never leaves a truncated file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}
