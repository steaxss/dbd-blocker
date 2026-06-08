import { app } from 'electron'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import https from 'https'

const AWS_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json'
const FETCH_TIMEOUT_MS = 15_000

type AwsPrefixEntry = { ip_prefix: string; region: string; service: string }
type AwsIpRanges = { prefixes: AwsPrefixEntry[] }

function getCacheDir(): string {
  return join(app.getPath('userData'), 'ips')
}

function getCachePath(regionId: string): string {
  return join(getCacheDir(), `${regionId}.json`)
}

async function ensureCacheDir(): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} while fetching ${url}`))
        return
      }
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout while fetching ${url}`))
    })
    req.on('error', reject)
  })
}

async function fetchAwsRanges(): Promise<AwsIpRanges> {
  const data = (await fetchJson(AWS_URL)) as AwsIpRanges
  if (!Array.isArray(data.prefixes)) {
    throw new Error('AWS IP ranges payload is invalid')
  }
  return data
}

function extractRegionCidrs(data: AwsIpRanges, regionId: string): string[] {
  const cidrs = data.prefixes
    .filter(
      (entry) =>
        entry.region === regionId &&
        entry.ip_prefix &&
        !entry.ip_prefix.includes(':') &&
        entry.service === 'EC2'
    )
    .map((entry) => entry.ip_prefix)

  return [...new Set(cidrs)].sort()
}

export async function fetchRegionCidrs(regionId: string): Promise<string[]> {
  const data = await fetchAwsRanges()
  return extractRegionCidrs(data, regionId)
}

export async function getCachedCidrs(regionId: string): Promise<string[] | null> {
  const path = getCachePath(regionId)
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf-8')
    const { cidrs } = JSON.parse(raw)
    return Array.isArray(cidrs) ? cidrs : null
  } catch {
    return null
  }
}

export async function cacheCidrs(regionId: string, cidrs: string[]): Promise<void> {
  await ensureCacheDir()
  await writeFile(
    getCachePath(regionId),
    JSON.stringify({ regionId, cidrs, cachedAt: new Date().toISOString() }),
    'utf-8'
  )
}

export async function getCidrs(regionId: string, forceRefresh = false): Promise<string[]> {
  if (!forceRefresh) {
    const cached = await getCachedCidrs(regionId)
    if (cached && cached.length > 0) return cached
  }
  const cidrs = await fetchRegionCidrs(regionId)
  await cacheCidrs(regionId, cidrs)
  return cidrs
}

export async function refreshAllCidrs(
  regionIds: string[]
): Promise<Record<string, { cidrs: string[]; added: number; removed: number }>> {
  const data = await fetchAwsRanges()
  const result: Record<string, { cidrs: string[]; added: number; removed: number }> = {}

  for (const regionId of regionIds) {
    const old = await getCachedCidrs(regionId)
    const oldSet = new Set(old ?? [])
    const cidrs = extractRegionCidrs(data, regionId)
    await cacheCidrs(regionId, cidrs)
    const newSet = new Set(cidrs)
    result[regionId] = {
      cidrs,
      added: cidrs.filter((c) => !oldSet.has(c)).length,
      removed: (old ?? []).filter((c) => !newSet.has(c)).length,
    }
  }

  return result
}

export async function getCidrCounts(
  regionIds: string[]
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const id of regionIds) {
    const cached = await getCachedCidrs(id)
    counts[id] = cached?.length ?? 0
  }
  return counts
}
