import { describe, expect, it } from 'vitest'
import { assertProductionPlanEvidenceSnapshot } from '../server/seo-geo-core/repository'

describe('Production Plan creation gates', () => {
  it('blocks a stale approved evidence snapshot before plan creation', () => {
    expect(() => assertProductionPlanEvidenceSnapshot(['current-hash'], 'stale-hash')).toThrowError(/stale/i)
  })

  it('blocks mixed strategy snapshots before plan creation', () => {
    expect(() => assertProductionPlanEvidenceSnapshot(['hash-a', 'hash-b'], 'hash-a')).toThrowError(/stale/i)
  })

  it('accepts one current snapshot', () => {
    expect(assertProductionPlanEvidenceSnapshot(['same-hash', 'same-hash'], 'same-hash')).toBe('same-hash')
  })
})
