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
    expect(result.policy).toMatchObject({ ownerUserId: 1, clientId: client.id, status: 'enabled', requireApprovedForDelivery: true, requirePassedRiskGate: true })
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
    const revoked = await revokeOwnerAutopilot(1, client.id, fixture.repository)
    expect(revoked.replayed).toBe(false)
    expect(revoked.policy.status).toBe('revoked')
    expect(fixture.autopilotPolicies[0]?.status).toBe('revoked')
    const replay = await revokeOwnerAutopilot(1, client.id, fixture.repository)
    expect(replay.replayed).toBe(true)
    expect(replay.policy.policyId).toBe(enabled.policy.policyId)
    expect((await getOwnerAutopilotPolicy(1, client.id, fixture.repository)).policy?.status).toBe('revoked')
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
