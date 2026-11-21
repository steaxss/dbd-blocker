// Proof that blocks are effective: counts the connection attempts of the game that Windows dropped
// because of the app filters (WFP net events). Filters are scoped to the game executable, so every
// counted drop is Dead by Daylight trying to reach a blocked region (matchmaking pings or game servers).

export interface RegionProof {
  /** Blocked connection attempts since the app started. */
  count: number
  lastAt: string
  lastRemote: string
}

export interface BlockProof {
  /** false when Windows does not keep its WFP drop log (net event collection disabled). */
  available: boolean
  regions: Record<string, RegionProof>
  total: number
}

export interface DropEvent {
  time: string
  region: string
  filterId: string
  remote: string
  port: number
  localPort: number
}

const MAX_REMEMBERED = 20_000

export function emptyProof(): BlockProof {
  return { available: true, regions: {}, total: 0 }
}

function eventKey(e: DropEvent): string {
  return `${e.time}|${e.filterId}|${e.localPort}|${e.remote}|${e.port}`
}

/**
 * Adds the drop events not seen yet (polls overlap on purpose so nothing is missed).
 * Returns true when the proof changed.
 */
export function mergeDropEvents(proof: BlockProof, seen: Set<string>, events: DropEvent[]): boolean {
  let changed = false
  const sorted = [...events].sort((a, b) => a.time.localeCompare(b.time))
  for (const e of sorted) {
    const key = eventKey(e)
    if (seen.has(key)) continue
    seen.add(key)
    const remote = e.remote.includes(':') ? `[${e.remote}]:${e.port}` : `${e.remote}:${e.port}`
    const current = proof.regions[e.region] ?? { count: 0, lastAt: '', lastRemote: '' }
    proof.regions[e.region] = {
      count: current.count + 1,
      lastAt: e.time > current.lastAt ? e.time : current.lastAt,
      lastRemote: e.time >= current.lastAt ? remote : current.lastRemote,
    }
    proof.total++
    changed = true
  }
  if (seen.size > MAX_REMEMBERED) {
    // Old keys are outside every future polling window: forgetting them cannot double count.
    const keep = [...seen].slice(-MAX_REMEMBERED / 2)
    seen.clear()
    for (const k of keep) seen.add(k)
  }
  return changed
}

export interface ProofMonitorDeps {
  hasBlocks: () => boolean
  readDrops: (seconds: number) => Promise<{ available: boolean; events: DropEvent[] }>
  emit: (proof: BlockProof) => void
}

const POLL_MS = 20_000
const WINDOW_SECONDS = 90

/** Polls the WFP drop log while at least one region is blocked. Returns a stop function. */
export function startProofMonitor(deps: ProofMonitorDeps): { stop: () => void; get: () => BlockProof; pollNow: () => Promise<void> } {
  const proof = emptyProof()
  const seen = new Set<string>()
  let busy = false

  const poll = async (): Promise<void> => {
    if (busy || !deps.hasBlocks()) return
    busy = true
    try {
      const res = await deps.readDrops(WINDOW_SECONDS)
      const availabilityChanged = proof.available !== res.available
      proof.available = res.available
      if (mergeDropEvents(proof, seen, res.events) || availabilityChanged) deps.emit(proof)
    } catch {
      // Transient (BFE busy, script timeout): next poll retries.
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => void poll(), POLL_MS)
  return { stop: () => clearInterval(timer), get: () => proof, pollNow: poll }
}
