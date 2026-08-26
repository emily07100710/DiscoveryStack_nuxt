import { describe, expect, it } from 'vitest'
import { createIntegrationMemoryRepository } from './fixtures/managed-site/modules-repository'
import { createProvisioningMemoryRepository } from './fixtures/managed-site/provisioning-repository'

const integrationInput = (ownerUserId: number, projectId: number) => ({
  ownerUserId,
  projectId,
  moduleKey: 'pwa_reference_only' as const,
  providerKey: 'site-runtime-neutral',
  status: 'not_configured' as const,
  authorizationMode: 'none' as const,
  requiredScopes: [],
  redactedConfig: {},
  shopDomain: null,
  intentFingerprint: 'a'.repeat(64),
  idempotencyKey: 'same-integration-key',
  externalReference: null,
})

const domainInput = (ownerUserId: number, projectId: number) => ({
  ownerUserId,
  projectId,
  draftOrderId: null,
  mode: 'new_registration' as const,
  requestedDomain: `owner-${ownerUserId}.acme.taipei`,
  normalizedDomain: `owner-${ownerUserId}.acme.taipei`,
  ownershipStatus: 'unknown' as const,
  purchaseStatus: 'intent_created' as const,
  dnsStatus: 'not_requested' as const,
  providerKey: 'mock-registrar',
  providerReference: null,
  configurationFingerprint: `${ownerUserId}`.repeat(64),
  idempotencyKey: 'same-domain-key',
})

const planInput = (ownerUserId: number, projectId: number, versionId: number, domainIntentId: number) => ({
  ownerUserId,
  projectId,
  versionId,
  domainIntentId,
  platform: 'manual_export' as const,
  deploymentMode: 'preview_only' as const,
  status: 'draft' as const,
  domainStatus: 'not_started' as const,
  dnsStatus: 'not_started' as const,
  tlsStatus: 'not_started' as const,
  deploymentStatus: 'not_started' as const,
  intentFingerprint: 'b'.repeat(64),
  idempotencyKey: 'same-plan-key',
  providerProjectReference: null,
  providerDeploymentReference: null,
  deployedUrl: null,
  tlsCertificateReference: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  retryEligibleAt: null,
})

describe('managed-site owner-scoped idempotency boundaries', () => {
  it('does not cross-replay integration keys or fingerprints between owners', async () => {
    const line = createIntegrationMemoryRepository()
    const first = await line.repository.insert(integrationInput(1, 101))
    const second = await line.repository.insert(integrationInput(2, 202))
    expect(first.id).not.toBe(second.id)
    expect(await line.repository.findByIdempotency(1, 'same-integration-key')).toBe(first)
    expect(await line.repository.findByIdempotency(2, 'same-integration-key')).toBe(second)
    expect(await line.repository.findByFingerprint(1, 'a'.repeat(64))).toBe(first)
    expect(await line.repository.findByFingerprint(2, 'a'.repeat(64))).toBe(second)
    await expect(line.repository.insert(integrationInput(1, 303))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('does not cross-replay domain intents or provisioning plans between owners', async () => {
    const line = createProvisioningMemoryRepository()
    const firstDomain = await line.repository.insertDomainIntent(domainInput(1, 101))
    const secondDomain = await line.repository.insertDomainIntent(domainInput(2, 202))
    expect(await line.repository.findDomainIntentByIdempotency(1, 'same-domain-key')).toBe(firstDomain)
    expect(await line.repository.findDomainIntentByIdempotency(2, 'same-domain-key')).toBe(secondDomain)
    await expect(line.repository.insertDomainIntent(domainInput(1, 303))).rejects.toMatchObject({ statusCode: 409 })

    const firstPlan = await line.repository.insertPlan(planInput(1, 101, 1001, firstDomain.id))
    const secondPlan = await line.repository.insertPlan(planInput(2, 202, 2002, secondDomain.id))
    expect(await line.repository.findPlanByIdempotency(1, 'same-plan-key')).toBe(firstPlan)
    expect(await line.repository.findPlanByIdempotency(2, 'same-plan-key')).toBe(secondPlan)
    expect(await line.repository.findPlanByFingerprint(1, 'b'.repeat(64))).toBe(firstPlan)
    expect(await line.repository.findPlanByFingerprint(2, 'b'.repeat(64))).toBe(secondPlan)
    await expect(line.repository.insertPlan(planInput(1, 404, 4004, firstDomain.id))).rejects.toMatchObject({ statusCode: 409 })
  })
})
