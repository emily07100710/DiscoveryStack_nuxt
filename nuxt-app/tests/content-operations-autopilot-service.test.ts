import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createOwnerPublicationTarget } from '../server/content-operations/orchestrator'
import { enableOwnerAutopilot, getOwnerAutopilotPolicy, revokeOwnerAutopilot } from '../server/content-operations/autopilot-service'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

function targetInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'target-autopilot-1',
    framework: 'nuxt',
    transport: 'first_party_git',
    targetOrigin: 'https://api.github.com',
    contentRoot: 'content',
    defaultBranch: 'main',
    repositoryOwner: 'owner',
    repositoryName: 'repository',
    endpointPath: null,
    credentialReference: 'server-ref-1',
    allowedContentTypes: ['article', 'faq', 'service_page'],
    allowedLanguages: ['en', 'zh-hant'],
    maximumPayloadBytes: 1000000,
    executionEnabled: true,
    ...overrides,
  }
}

async function configuredFixture() {
  const fixture = new ContentOperationsFixture()
  const client = fixture.addClient(1)
  const created = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
  return { fixture, client, target: fixture.targets.find(item => item.id === created.target.id)! }
}

describe('durable owner autopilot service', () => {
  it('persists an owner-enabled policy without returning credential material', async () => {
    const { fixture, client } = await configuredFixture()
    const result = await enableOwnerAutopilot(1, client.id, { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en', 'zh-hant'] }, fixture.repository)
    expect(result.replayed).toBe(false)
    expect(result.policy).toMatchObject({ ownerUserId: 1, clientId: client.id, status: 'enabled', requireApprovedForDelivery: false, requirePassedRiskGate: true })
    expect(fixture.autopilotPolicies).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('server-ref-1')
    await expect(enableOwnerAutopilot(1, client.id, { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)).rejects.toThrow(/already exists/)
  })

  it('requires target execution to be enabled before owner authorization', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    await createOwnerPublicationTarget(1, client.id, targetInput({ executionEnabled: false }), fixture.repository)
    await expect(enableOwnerAutopilot(1, client.id, { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)).rejects.toThrow(/explicitly enabled/)
  })

  it('revokes durably and treats repeated revoke as a safe replay', async () => {
    const { fixture, client } = await configuredFixture()
    const enabled = await enableOwnerAutopilot(1, client.id, { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)
    const revokeNow = new Date('2026-08-26T08:00:00.000Z')
    const revoked = await revokeOwnerAutopilot(1, client.id, fixture.repository, revokeNow)
    expect(revoked.replayed).toBe(false)
    expect(revoked.policy.status).toBe('revoked')
    expect(revoked.policy.revokedAt).toBe(revokeNow.toISOString())
    expect(fixture.autopilotPolicies[0]?.status).toBe('revoked')
    const replay = await revokeOwnerAutopilot(1, client.id, fixture.repository)
    expect(replay.replayed).toBe(true)
    expect(replay.policy.policyId).toBe(enabled.policy.policyId)
    expect((await getOwnerAutopilotPolicy(1, client.id, fixture.repository)).policy?.status).toBe('revoked')
  })

  it('revokes every enabled or paused target policy atomically and preserves delivered receipts', async () => {
    const { fixture, client, target } = await configuredFixture()
    const secondCreated = await createOwnerPublicationTarget(1, client.id, targetInput({ idempotencyKey: 'target-autopilot-2' }), fixture.repository)
    const secondTarget = fixture.targets.find(item => item.id === secondCreated.target.id)!
    const first = await enableOwnerAutopilot(1, client.id, { targetRowId: target.id, expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)
    const second = await enableOwnerAutopilot(1, client.id, { targetRowId: secondTarget.id, expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)
    fixture.autopilotPolicies.find(policy => policy.policyId === second.policy.policyId)!.status = 'paused'
    fixture.attempts.push({ id: 999, ownerUserId: 1, clientId: client.id, entryId: 1, runId: 2, targetId: target.id, websiteId: target.websiteId, routingPlanId: 'route', routeId: 'route-1', executorRunId: 'executor-1', authorityReference: `ref-autopilot-${first.policy.policyId}`, publicationUrl: 'https://owner.example/published', receiptFingerprint: 'receipt-before', mode: 'execute', attemptNumber: 1, idempotencyKey: 'attempt-before', inputFingerprint: 'input-before', publicationId: 'publication-1', publicationSlug: 'article-1', publicationPath: '/content/article-1', contentHash: 'content-before', publicationContentHash: 'content-before', evidenceSnapshotHash: 'e'.repeat(64), artifactFingerprint: 'artifact-before', status: 'delivered', remoteState: 'delivered', receiptLedger: [{ publicationId: 'publication-1', contentHash: 'content-before', remoteRevision: 'remote-1' }], remoteRevision: 'remote-1', errorCode: null, errorSummary: null, startedAt: new Date('2026-08-25T04:00:00.000Z'), completedAt: new Date('2026-08-25T04:00:01.000Z'), createdAt: new Date('2026-08-25T04:00:00.000Z') } as never)
    const beforeReceipt = JSON.stringify(fixture.attempts)
    const revoked = await revokeOwnerAutopilot(1, client.id, fixture.repository)
    expect(revoked.replayed).toBe(false)
    expect(revoked.revokedCount).toBe(2)
    expect(revoked.revokedPolicies.map(policy => policy.policyId).sort()).toEqual([first.policy.policyId, second.policy.policyId].sort())
    expect(fixture.autopilotPolicies.every(policy => policy.status === 'revoked')).toBe(true)
    expect(fixture.events.filter(event => event.eventType === 'autopilot_policy_revoked')).toHaveLength(2)
    expect(JSON.stringify(fixture.attempts)).toBe(beforeReceipt)
    const replay = await revokeOwnerAutopilot(1, client.id, fixture.repository)
    expect(replay.replayed).toBe(true)
    expect(replay.revokedCount).toBe(0)
    expect(replay.alreadyRevokedPolicies).toHaveLength(2)
  })

  it('rolls back all policy mutations and revoke events when one target revoke fails', async () => {
    const { fixture, client, target } = await configuredFixture()
    const secondCreated = await createOwnerPublicationTarget(1, client.id, targetInput({ idempotencyKey: 'target-autopilot-rollback-2' }), fixture.repository)
    const secondTarget = fixture.targets.find(item => item.id === secondCreated.target.id)!
    await enableOwnerAutopilot(1, client.id, { targetRowId: target.id, expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)
    await enableOwnerAutopilot(1, client.id, { targetRowId: secondTarget.id, expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)
    const originalRevoke = fixture.repository.revokeAutopilotPolicy
    let calls = 0
    fixture.repository.revokeAutopilotPolicy = async (...args) => {
      calls += 1
      if (calls === 2) throw new Error('injected revoke failure')
      return originalRevoke(...args)
    }
    const beforeEvents = fixture.events.length
    await expect(revokeOwnerAutopilot(1, client.id, fixture.repository)).rejects.toThrow('injected revoke failure')
    fixture.repository.revokeAutopilotPolicy = originalRevoke
    expect(fixture.autopilotPolicies.every(policy => policy.status === 'enabled')).toBe(true)
    expect(fixture.events).toHaveLength(beforeEvents)
  })

  it('does not revoke another owner client and returns all client policy projections', async () => {
    const { fixture, client } = await configuredFixture()
    const ownerTwoClient = fixture.addClient(2)
    const ownerTwoTargetResult = await createOwnerPublicationTarget(2, ownerTwoClient.id, targetInput({ idempotencyKey: 'target-owner-two' }), fixture.repository)
    const ownerTwoTarget = fixture.targets.find(item => item.id === ownerTwoTargetResult.target.id)!
    await enableOwnerAutopilot(1, client.id, { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)
    const ownerTwoPolicy = await enableOwnerAutopilot(2, ownerTwoClient.id, { targetRowId: ownerTwoTarget.id, expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository)
    const revoked = await revokeOwnerAutopilot(1, client.id, fixture.repository)
    expect(revoked.policy.ownerUserId).toBe(1)
    expect(fixture.autopilotPolicies.find(policy => policy.policyId === ownerTwoPolicy.policy.policyId)?.status).toBe('enabled')
    const view = await getOwnerAutopilotPolicy(1, client.id, fixture.repository)
    expect(view.policies).toHaveLength(1)
    expect(view.revokedPolicies).toHaveLength(1)
    expect(view.activePolicies).toHaveLength(0)
  })

  it('keeps owner scope and routes owner-only', () => {
    const enableRoute = readFileSync(new URL('../server/api/content-operations/clients/[id]/autopilot-policy.post.ts', import.meta.url), 'utf8')
    const revokeRoute = readFileSync(new URL('../server/api/content-operations/clients/[id]/autopilot-policy.revoke.post.ts', import.meta.url), 'utf8')
    const getRoute = readFileSync(new URL('../server/api/content-operations/clients/[id]/autopilot-policy.get.ts', import.meta.url), 'utf8')
    for (const route of [enableRoute, revokeRoute, getRoute]) expect(route).toContain('requireOwner')
    expect(enableRoute).toContain('enableOwnerAutopilot')
    expect(revokeRoute).toContain('revokeOwnerAutopilot')
    expect(getRoute).toContain('getOwnerAutopilotPolicy')
  })
})
