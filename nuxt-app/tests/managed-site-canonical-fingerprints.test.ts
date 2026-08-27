import { describe, expect, it } from 'vitest'
import { compareCodeUnits, canonicalArtifactCollisionKey } from '../server/managed-sites/live-connectors/canonical'
import { managedSiteCommerceSnapshotFingerprint } from '../server/managed-sites/prepurchase-service'

describe('managed-site locale-independent canonical fingerprints', () => {
  it('uses explicit code-unit ordering for Unicode without consulting locale APIs', () => {
    const values = ['ä', 'Z', 'a', 'İ', 'é', 'e\u0301']
    const expected = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    expect([...values].sort(compareCodeUnits)).toEqual(expected)
    expect(canonicalArtifactCollisionKey('É/INDEX.ASTRO')).toBe(canonicalArtifactCollisionKey('É/index.astro'))
  })

  it('produces one commercial fingerprint for every input line order', () => {
    const core = { previewId: 1, quoteId: 2, draftOrderId: 3, quoteVersion: 'quote-v1', totalMinor: 300, currency: 'USD', planKey: 'basic', cadenceDays: 7, domainOption: 'new', taxStatus: 'not_calculated' }
    const lines = [
      { lineKey: 'é-module', quantity: 1, unitAmountMinor: 100, lineAmountMinor: 100, lineFingerprint: 'a'.repeat(64) },
      { lineKey: 'Z-base', quantity: 1, unitAmountMinor: 200, lineAmountMinor: 200, lineFingerprint: 'b'.repeat(64) },
    ]
    expect(managedSiteCommerceSnapshotFingerprint({ ...core, lines })).toBe(managedSiteCommerceSnapshotFingerprint({ ...core, lines: [...lines].reverse() }))
  })
})
