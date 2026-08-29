import { describe, expect, it } from 'vitest'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

const HASH = 'a'.repeat(64)
const NOW = new Date('2026-08-25T04:00:00.000Z')

describe('Content Operations V4 concurrency primitives', () => {
  it('allows only one repair provider claimant for the same canonical parent draft', async () => {
    const fixture = new ContentOperationsFixture()
    fixture.addClient(1)
    const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
    const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
    const repairFingerprint = 'b'.repeat(64)
    await fixture.repository.insertRepairAttempt({ ownerUserId: 1, clientId: calendar.clientId, websiteId: 'website-1', entryId: entry.id, originalDraftId: 'draft-1', originalContentHash: HASH, repairAttempt: 1, reasonCodes: ['DIRECT_ANSWER_MISSING'], failingMetrics: { hasDirectAnswer: 0 }, evidenceDeficiencies: [], entityCoverageDeficiencies: [], prohibitedClaimLocations: [], citationDeficiencies: [], keywordStuffingLocations: [], internalLinkDeficiencies: [], requestedRepairs: [{ code: 'DIRECT_ANSWER_MISSING', instruction: 'Add an evidence-bound direct answer.' }], providerModel: 'mock:qwen', repairedDraftId: null, repairedContentHash: null, parentLineage: { entryId: entry.id, draftId: 1, contentHash: HASH, evidenceSnapshotHash: entry.evidenceSnapshotHash }, repairFingerprint, status: 'planned', leaseOwner: null, leaseExpiresAt: null })
    const claims = await Promise.all([
      fixture.repository.claimRepairAttempt(1, repairFingerprint, 'worker-a', NOW, new Date(NOW.getTime() + 60_000)),
      fixture.repository.claimRepairAttempt(1, repairFingerprint, 'worker-b', NOW, new Date(NOW.getTime() + 60_000)),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(claims.filter(Boolean)[0]?.leaseOwner).toMatch(/^worker-[ab]$/)
  })
})
