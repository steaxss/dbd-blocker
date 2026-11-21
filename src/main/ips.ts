import { app } from 'electron'
import https from 'https'
import { join } from 'path'
import { readdir, rm } from 'fs/promises'
import { diffCidrs } from './cidr'
import { extractAllRegions, validateAwsRanges } from './aws-ranges'
import { readJson, writeJsonAtomic } from './fs-utils'
import { REGION_IDS } from './regions'

const AWS_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json'
const FETCH_TIMEOUT_MS = 20_000
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
const CACHE_VERSION = 2

interface RangeCache {
  version: number
  syncToken: string
  createDate: string
  fetchedAt: string
  regions: Record<string, string[]>
}

export interface RefreshResult {
  syncToken: string
  createDate: string
  changed: boolean
  regions: Record<string, { cidrs: string[]; added: number; removed: number }>
}

let memory: RangeCache | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'aws-ranges.json')
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS, headers: { 'User-Agent': 'dbd-server-blocker' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error(`HTTP ${status} while fetching ${url}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_PAYLOAD_BYTES) {
          req.destroy(new Error('AWS IP ranges payload too large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        } catch (e) {
          reject(e)
        }
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`Timeout while fetching ${url}`)))
    req.on('error', reject)
  })
}

async function loadCache(): Promise<RangeCache | null> {
  if (memory) return memory
  const data = await readJson<RangeCache>(cachePath())
  if (data && data.version === CACHE_VERSION && data.regions && typeof data.regions === 'object') {
    memory = data
    return data
  }
  return null
}

/** v1.x kept one file per region in userData/ips (IPv4 only). Remove it: the new cache supersedes it. */
async function removeLegacyCache(): Promise<void> {
  const dir = join(app.getPath('userData'), 'ips')
  try {
    const files = await readdir(dir)
    if (files.every((f) => f.endsWith('.json'))) await rm(dir, { recursive: true, force: true })
  } catch {
    // nothing to clean
  }
}

export async function refreshRanges(): Promise<RefreshResult> {
  const previous = await loadCache()
  const data = validateAwsRanges(await fetchJson(AWS_URL))
  const regions = extractAllRegions(data, REGION_IDS)

  const result: RefreshResult = {
    syncToken: data.syncToken,
    createDate: data.createDate,
    changed: previous?.syncToken !== data.syncToken,
    regions: {},
  }
  for (const id of REGION_IDS) {
    const { added, removed } = diffCidrs(previous?.regions[id] ?? [], regions[id])
    result.regions[id] = { cidrs: regions[id], added: previous ? added.length : 0, removed: previous ? removed.length : 0 }
  }

  memory = {
    version: CACHE_VERSION,
    syncToken: data.syncToken,
    createDate: data.createDate,
    fetchedAt: new Date().toISOString(),
    regions,
  }
  await writeJsonAtomic(cachePath(), memory)
  await removeLegacyCache()
  return result
}

/** Cached ranges of a region (IPv4 + IPv6). Fetches once if nothing is cached yet. */
export async function getRegionRanges(regionId: string): Promise<string[]> {
  let cache = await loadCache()
  if (!cache) {
    await refreshRanges()
    cache = await loadCache()
  }
  return cache?.regions[regionId] ?? []
}

export async function getAllRanges(): Promise<Record<string, string[]>> {
  return (await loadCache())?.regions ?? {}
}

export async function getRangeCounts(): Promise<Record<string, number>> {
  const regions = await getAllRanges()
  const counts: Record<string, number> = {}
  for (const id of REGION_IDS) counts[id] = regions[id]?.length ?? 0
  return counts
}

export async function getCacheInfo(): Promise<{ syncToken: string; createDate: string; fetchedAt: string } | null> {
  const cache = await loadCache()
  return cache ? { syncToken: cache.syncToken, createDate: cache.createDate, fetchedAt: cache.fetchedAt } : null
}
