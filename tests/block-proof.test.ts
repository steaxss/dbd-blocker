import { describe, expect, it, vi } from 'vitest'
import { emptyProof, mergeDropEvents, startProofMonitor, type DropEvent } from '../src/main/block-proof'

const drop = (over: Partial<DropEvent> = {}): DropEvent => ({
  time: '2026-11-21T21:08:07.691Z',
  region: 'ap-northeast-2',
  filterId: '74207',
  remote: '3.36.113.12',
  port: 7770,
  localPort: 49523,
  ...over,
})

describe('mergeDropEvents', () => {
  it('counts each drop once even when polling windows overlap', () => {
    const proof = emptyProof()
    const seen = new Set<string>()
    expect(mergeDropEvents(proof, seen, [drop(), drop({ localPort: 60815, time: '2026-11-21T21:08:21.411Z' })])).toBe(true)
    expect(mergeDropEvents(proof, seen, [drop()])).toBe(false)
    expect(proof.total).toBe(2)
    expect(proof.regions['ap-northeast-2']).toEqual({
      count: 2,
      relayCount: 0,
      lastAt: '2026-11-21T21:08:21.411Z',
      lastRemote: '3.36.113.12:7770',
    })
  })

  it('tracks regions separately and formats IPv6 endpoints', () => {
    const proof = emptyProof()
    mergeDropEvents(proof, new Set(), [drop({ region: 'eu-west-2', remote: '2a05:d01c::1', port: 7777 })])
    expect(proof.regions['eu-west-2'].lastRemote).toBe('[2a05:d01c::1]:7777')
    expect(proof.regions['ap-northeast-2']).toBeUndefined()
  })
})

describe('relay drops', () => {
  it('counts attempts aimed at relays separately', () => {
    const proof = emptyProof()
    mergeDropEvents(proof, new Set(), [drop(), drop({ remote: '54.115.85.191', port: 7791, localPort: 1, relay: true })])
    expect(proof.regions['ap-northeast-2'].count).toBe(2)
    expect(proof.regions['ap-northeast-2'].relayCount).toBe(1)
  })
})

describe('startProofMonitor', () => {
  it('does not poll Windows when nothing is blocked', async () => {
    const readDrops = vi.fn()
    const m = startProofMonitor({ hasBlocks: () => false, readDrops, emit: vi.fn() })
    await m.pollNow()
    m.stop()
    expect(readDrops).not.toHaveBeenCalled()
  })

  it('emits when new drops arrive or the log becomes unavailable', async () => {
    const emit = vi.fn()
    let result = { available: true, events: [drop()] }
    const m = startProofMonitor({ hasBlocks: () => true, readDrops: async () => result, emit })
    await m.pollNow()
    await m.pollNow() // same event again: no emit
    result = { available: false, events: [] }
    await m.pollNow()
    m.stop()
    expect(emit).toHaveBeenCalledTimes(2)
    expect(m.get().total).toBe(1)
    expect(m.get().available).toBe(false)
  })
})
