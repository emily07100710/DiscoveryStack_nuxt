import { describe, expect, it } from 'vitest'
import { revalidateConsumedWeeklyPublicationConsent, type ConsumedWeeklyPublicationContext } from '../server/weekly-content/site-measurement-consent'
import type { WeeklyConsent, WeeklyConfig, WeeklyReviewRequest, PrivateLineBinding } from '../server/weekly-content/types'
import { WeeklyFixture, WEEKLY_HASH, WEEKLY_NOW, sha } from './fixtures/weekly-content/repository'

const later = new Date('2026-10-08T00:00:00.000Z')

function fixture() {
  const f = new WeeklyFixture()
  const startedAt = new Date(WEEKLY_NOW.getTime() + 10_000)
  f.state.config = {
    id: 12, ownerUserId: 1, clientId: 1, publicationTargetId: 3, policyId: 'policy-1',
    policyConfigurationFingerprint: WEEKLY_HASH, configurationFingerprint: sha('weekly-config'), status: 'active',
    idempotencyKey: 'synthetic-config', cadenceDays: 7, reviewTtlHours: 72,
    createdAt: WEEKLY_NOW, updatedAt: WEEKLY_NOW,
  } as WeeklyConfig
  f.state.binding = {
    id: 13, ownerUserId: 1, clientId: 1, lineUserId: 'U_SYNTHETIC_ONLY', bindingFingerprint: sha('line-binding'),
    status: 'active', createdAt: WEEKLY_NOW, updatedAt: WEEKLY_NOW,
  } as PrivateLineBinding
  f.state.draft.entryStatus = 'awaiting_site_review'
  f.state.draft.machineAuthorizationValid = false
  const request = {
    id: 14, requestId: 'wcr_synthetic', ownerUserId: 1, clientId: 1, entryId: 8, jobId: 9,
    contentType: 'article', language: 'zh-hant', draftId: 10, draftVersion: 1, contentHash: WEEKLY_HASH,
    evidenceSnapshotHash: WEEKLY_HASH, publicationTargetId: 3, targetConfigurationFingerprint: WEEKLY_HASH,
    policyId: 'policy-1', policyConfigurationFingerprint: WEEKLY_HASH,
    configurationFingerprint: f.state.config.configurationFingerprint, bindingId: 13,
    bindingFingerprint: f.state.binding.bindingFingerprint, readTokenHash: sha('read'), actionTokenHash: sha('action'),
    requestFingerprint: sha('exact-request'), status: 'approved', expiresAt: new Date(startedAt.getTime() + 72 * 60 * 60 * 1000),
    createdAt: new Date(startedAt.getTime() - 1_000), updatedAt: startedAt,
  } as WeeklyReviewRequest
  f.state.requests.push(request)
  f.state.consents.push({
    id: 15, ownerUserId: 1, clientId: 1, requestRowId: request.id, decision: 'approved', eventHash: sha('event'),
    actorFingerprint: sha('actor'), consentFingerprint: sha('consent'), createdAt: new Date(startedAt.getTime() - 500),
  } as WeeklyConsent)
  const attempt: ConsumedWeeklyPublicationContext = {
    status: 'draft_received', ownerUserId: 1, clientId: 1, entryId: 8, jobId: 9, draftId: 10, draftVersion: 1,
    contentType: 'article', language: 'zh-hant', contentHash: WEEKLY_HASH, evidenceSnapshotHash: WEEKLY_HASH,
    targetId: 3, targetConfigurationFingerprint: WEEKLY_HASH, startedAt, authorityReference: sha('machine-auth'),
    reviewId: null, machineAuthorization: { authorizationFingerprint: sha('machine-auth'), status: 'draft_received', revokedAt: null },
  }
  const run = (overrides: Partial<ConsumedWeeklyPublicationContext> = {}, now = later) => revalidateConsumedWeeklyPublicationConsent({
    ownerUserId: 1, clientId: 1, entryId: 8, attempt: { ...attempt, ...overrides }, now, repository: f.repository,
  })
  return { f, attempt, request, run }
}

describe('consumed weekly publication consent for site measurement', () => {
  it('revalidates exact approved consent after the review TTL and ignores an expired short machine lease', async () => {
    const { f, run } = fixture()
    const result = await run()
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.authorityFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(f.state.draft.machineAuthorizationValid).toBe(false)
  })

  it('produces a stable, non-identifying authority fingerprint independent of observation clock', async () => {
    const { run } = fixture()
    const first = await run({}, later)
    const second = await run({}, new Date(later.getTime() + 60_000))
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).not.toContain('U_SYNTHETIC_ONLY')
  })

  it.each([
    ['wrong machine terminal state', { machineAuthorization: { authorizationFingerprint: sha('machine-auth'), status: 'authorized', revokedAt: null } }],
    ['revoked machine authority', { machineAuthorization: { authorizationFingerprint: sha('machine-auth'), status: 'draft_received', revokedAt: later } }],
    ['authority fingerprint mismatch', { machineAuthorization: { authorizationFingerprint: sha('different-auth'), status: 'draft_received', revokedAt: null } }],
    ['different draft version', { draftVersion: 2 }],
    ['different body hash', { contentHash: sha('other-body') }],
    ['different evidence version', { evidenceSnapshotHash: sha('other-evidence') }],
    ['different target', { targetId: 4 }],
  ] as const)('blocks %s', async (_label, override) => {
    const { run } = fixture()
    expect((await run(override as Partial<ConsumedWeeklyPublicationContext>)).status).toBe('blocked')
  })

  it.each(['client opt-out', 'paused config', 'revoked binding', 'latest request revoked', 'latest consent withdrawn', 'policy revoked', 'current draft changed'] as const)('fails closed when %s', async kind => {
    const { f, run, request } = fixture()
    if (kind === 'client opt-out') f.state.client.requireCustomerApproval = false
    if (kind === 'paused config') f.state.config!.status = 'paused'
    if (kind === 'revoked binding') f.state.binding!.status = 'revoked'
    if (kind === 'latest request revoked') request.status = 'revoked'
    if (kind === 'latest consent withdrawn') f.state.consents[0]!.decision = 'changes_requested'
    if (kind === 'policy revoked') f.state.policy.revokedAt = later
    if (kind === 'current draft changed') f.state.draft.contentHash = sha('changed-current-draft')
    expect((await run()).status).toBe('blocked')
  })

  it('allows manual owner-reviewed weekly attempts without fabricating a machine authorization', async () => {
    const { run } = fixture()
    const result = await run({ authorityReference: null, reviewId: 99, machineAuthorization: undefined })
    expect(result.status).toBe('verified')
  })

  it('blocks missing authority provenance instead of inferring a machine state', async () => {
    const { run } = fixture()
    const result = await run({ authorityReference: null, reviewId: null, machineAuthorization: undefined })
    expect(result.status).toBe('blocked')
  })
})
