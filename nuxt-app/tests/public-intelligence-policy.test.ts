import { describe, expect, it } from 'vitest'
import { assertPermittedPublicUse, maximumPermittedUse } from '../server/public-intelligence/policy'

describe('Public Intelligence policy gate', () => {
  it('keeps every pending public source in research-only mode regardless of claimed richness', () => {
    expect(maximumPermittedUse({ termsStatus: 'allows_training', copyrightRisk: 'low', piiStatus: 'none_detected', reviewStatus: 'pending' })).toBe('research_only')
  })

  it('permits a versioned training candidate only after an approved, explicit training policy with low risk and no detected PII', () => {
    expect(maximumPermittedUse({ termsStatus: 'allows_training', copyrightRisk: 'low', piiStatus: 'none_detected', reviewStatus: 'approved' })).toBe('training_candidate')
  })

  it('blocks prohibited automation and restricted PII from every data-use layer', () => {
    expect(maximumPermittedUse({ termsStatus: 'prohibits_automation', copyrightRisk: 'low', piiStatus: 'none_detected', reviewStatus: 'approved' })).toBe('blocked')
    expect(maximumPermittedUse({ termsStatus: 'allows_training', copyrightRisk: 'low', piiStatus: 'restricted', reviewStatus: 'approved' })).toBe('blocked')
    expect(() => assertPermittedPublicUse({ requestedUse: 'training_candidate', maximumUse: 'research_only' })).toThrow(/limited to research_only/)
  })

  it('allows an owner to make the safer, more restrictive blocked decision', () => {
    expect(() => assertPermittedPublicUse({ requestedUse: 'blocked', maximumUse: 'training_candidate' })).not.toThrow()
  })
})
