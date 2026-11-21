import { describe, expect, it } from 'vitest'
import { estimateRelayRegion, getRelayBlocks, regionBlockList } from '../src/main/relays'

describe('relays', () => {
  it('estimates the region of a located relay', () => {
    expect(estimateRelayRegion('54.115.85.191')).toBe('eu-west-1')
    expect(estimateRelayRegion('8.8.8.8')).toBeNull()
  })

  it('has located relay blocks for Seoul and Dublin', () => {
    expect(getRelayBlocks('ap-northeast-2').length).toBeGreaterThan(0)
    expect(getRelayBlocks('eu-west-1')).toContain('54.115.84.0/22')
    expect(getRelayBlocks('xx-none-1')).toEqual([])
  })

  it('adds relay blocks to a region block only when enabled', () => {
    const regional = ['3.34.0.0/15']
    const relays = getRelayBlocks('ap-northeast-2')
    expect(regionBlockList(regional, relays, false)).toEqual(['3.34.0.0/15'])
    const withRelays = regionBlockList(regional, relays, true)
    expect(withRelays).toContain('3.34.0.0/15')
    for (const r of relays) expect(withRelays).toContain(r)
  })

  it('never blocks relays alone when the region has no EC2 ranges', () => {
    expect(regionBlockList([], getRelayBlocks('ap-northeast-2'), true)).toEqual([])
  })
})
