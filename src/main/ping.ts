// Latency to the GameLift UDP ping beacons: gamelift-ping.<region>.api.aws, UDP 7770 (echo).
// These are the endpoints GameLift-based matchmaking measures, so the numbers match what the game sees
// far better than an HTTPS round-trip to the control-plane API (TLS + HTTP adds a lot of noise).
// The probe runs from the app process, which is never affected by the blocks (scoped to the game exe).
import dgram from 'dgram'
import { lookup } from 'dns/promises'
import { randomBytes } from 'crypto'

const BEACON_PORT = 7770
const SAMPLES = 6
const SAMPLE_TIMEOUT_MS = 1500

export interface PingResult {
  ok: boolean
  ip: string | null
  ms: number | null
  error?: string
}

export function beaconHost(regionId: string): string {
  return `gamelift-ping.${regionId}.api.aws`
}

function probe(socket: dgram.Socket, ip: string): Promise<number | null> {
  return new Promise((resolve) => {
    const token = randomBytes(8)
    const start = process.hrtime.bigint()
    const onMessage = (msg: Buffer): void => {
      if (!msg.equals(token)) return
      cleanup()
      resolve(Number(process.hrtime.bigint() - start) / 1e6)
    }
    const timer = setTimeout(() => { cleanup(); resolve(null) }, SAMPLE_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('message', onMessage)
    }
    socket.on('message', onMessage)
    socket.send(token, BEACON_PORT, ip, (err) => {
      if (err) { cleanup(); resolve(null) }
    })
  })
}

export async function pingRegion(regionId: string): Promise<PingResult> {
  const host = beaconHost(regionId)
  let ip: string
  try {
    ip = (await lookup(host, { family: 4 })).address
  } catch {
    return { ok: false, ip: null, ms: null, error: `Cannot resolve ${host}` }
  }

  const socket = dgram.createSocket('udp4')
  socket.on('error', () => { /* reported as lost samples */ })
  try {
    await probe(socket, ip) // warm-up (ARP / NAT mapping)
    const samples: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const ms = await probe(socket, ip)
      if (ms !== null) samples.push(ms)
    }
    if (samples.length === 0) return { ok: true, ip, ms: null, error: 'No reply from the ping beacon' }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor((samples.length - 1) / 2)]
    return { ok: true, ip, ms: Math.round(median) }
  } finally {
    socket.close()
  }
}
