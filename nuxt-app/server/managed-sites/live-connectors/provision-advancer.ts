import { buildManagedSitePreview, verifyExistingSiteOwnership } from './deployment-orchestrator'
import { getManagedSiteLiveConnectorRepository } from './repository'
import { managedSiteLiveDeploymentAdapter, managedSiteLiveOwnershipAdapter } from './runtime-adapters'
import type { ManagedSiteCredentialResolver, ManagedSiteDeploymentAdapter, ManagedSiteExistingSiteOwnershipAdapter, ManagedSiteLiveConnectorRepository } from './types'

type AdvancerDependencies = {
  repository?: ManagedSiteLiveConnectorRepository
  clock?: () => Date
  deploymentAdapter?: (ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) => Promise<ManagedSiteDeploymentAdapter>
  ownershipAdapter?: (ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) => Promise<ManagedSiteExistingSiteOwnershipAdapter>
  credentialResolver?: ManagedSiteCredentialResolver
}

type OnRequestAdvancer = (options: { ownerUserId?: number; limit?: number }) => Promise<{ scanned: number; advanced: number; failed: number }>
let testOnRequestAdvancer: OnRequestAdvancer | false = false

export function setManagedSiteOnRequestProvisionAdvancerForTests(advancer: OnRequestAdvancer | false): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Managed-site on-request advancer injection is test-only.')
  testOnRequestAdvancer = advancer
}

export function managedSiteOnRequestProvisionAdvancer(): OnRequestAdvancer | false {
  return process.env.NODE_ENV === 'test' ? testOnRequestAdvancer : advanceEligibleManagedSiteProvisioning
}

export async function advanceEligibleManagedSiteProvisioning(options: { ownerUserId?: number; limit?: number } = {}, dependencies: AdvancerDependencies = {}): Promise<{ scanned: number; advanced: number; failed: number }> {
  const summary = { scanned: 0, advanced: 0, failed: 0 }
  try {
    const repository = dependencies.repository || getManagedSiteLiveConnectorRepository(); const clock = dependencies.clock || (() => new Date()); const limit = Math.min(Math.max(options.limit || 10, 1), 50)
    const attempts = await repository.listEligibleRetryAttempts(clock(), limit, options.ownerUserId)
    summary.scanned = attempts.length
    for (const attempt of attempts) {
      if (!attempt.releaseId || attempt.executionMode !== 'live' || !['preview_build', 'existing_site_ownership_verify'].includes(attempt.operation)) continue
      try {
        if (attempt.operation === 'preview_build') {
          let adapter: ManagedSiteDeploymentAdapter
          try { adapter = await (dependencies.deploymentAdapter || managedSiteLiveDeploymentAdapter)(attempt.ownerUserId, repository) } catch { continue }
          await buildManagedSitePreview(attempt.ownerUserId, { releaseId: attempt.releaseId, executionMode: 'live', idempotencyKey: attempt.idempotencyKey }, adapter, { repository, clock, credentialResolver: dependencies.credentialResolver })
        } else {
          let adapter: ManagedSiteExistingSiteOwnershipAdapter
          try { adapter = await (dependencies.ownershipAdapter || managedSiteLiveOwnershipAdapter)(attempt.ownerUserId, repository) } catch { continue }
          const release = await repository.findRelease(attempt.ownerUserId, attempt.releaseId)
          const challenge = release ? (await repository.listReceipts(attempt.ownerUserId, release.projectId)).find(receipt => receipt.releaseId === release.id && receipt.receiptType === 'existing_site_challenge_created' && receipt.receiptStatus === 'verified') : null
          if (!challenge) continue
          await verifyExistingSiteOwnership(attempt.ownerUserId, { releaseId: attempt.releaseId, challengeReceiptFingerprint: challenge.receiptFingerprint, executionMode: 'live', idempotencyKey: attempt.idempotencyKey }, adapter, { repository, clock, credentialResolver: dependencies.credentialResolver })
        }
        summary.advanced++
      } catch { summary.failed++ }
    }
  } catch { /* scheduled/on-request advancement never escapes into the caller */ }
  return summary
}
