import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { getManagedSiteLiveConnectorRepository } from './repository'
import { getManagedSiteProviderReadiness, resolveManagedSiteCredential } from './provider-registry'
import type { ManagedSiteCredentialResolver, ManagedSiteLiveConnectorRepository } from './types'

export async function getManagedSiteLiveConnectorWorkspace(ownerUserId: number, dependencies: { repository?: ManagedSiteLiveConnectorRepository; managedRepository?: ManagedSiteRepository; credentialResolver?: ManagedSiteCredentialResolver } = {}) {
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const readiness = await getManagedSiteProviderReadiness(ownerUserId, repository, dependencies.credentialResolver || resolveManagedSiteCredential)
  const projects = await managedRepository.listProjects(ownerUserId)
  const projectRows = await Promise.all(projects.map(async project => {
    const [candidates, releases, attempts, receipts] = await Promise.all([
      repository.listGenerationCandidates(ownerUserId, project.id),
      repository.listReleases(ownerUserId, project.id),
      repository.listAttempts(ownerUserId, project.id),
      repository.listReceipts(ownerUserId, project.id),
    ])
    return {
      project: { id: project.id, canonicalClientIdentity: project.canonicalClientIdentity, canonicalWebsiteIdentity: project.canonicalWebsiteIdentity, status: project.status, siteType: project.siteType, activeVersionId: project.activeVersionId, contentOperationClientId: project.contentOperationClientId },
      candidates: candidates.map(candidate => ({ id: candidate.id, sourceVersionId: candidate.sourceVersionId, providerKey: candidate.providerKey, providerModel: candidate.providerModel, manifestHash: candidate.manifestHash, contentHash: candidate.contentHash, gateSummary: candidate.gateSummary, storedInOwnerVault: true, sourceDownloadAvailable: false, createdAt: candidate.createdAt })),
      releases: releases.map(release => ({ id: release.id, releaseKind: release.releaseKind, versionId: release.versionId, generationCandidateId: release.generationCandidateId, targetKey: release.targetKey, canonicalDomain: release.canonicalDomain, contentHash: release.contentHash, status: release.status, previewUrl: release.previewUrl, approvalRecorded: Boolean(release.approvalFingerprint), blockedReasonCode: release.blockedReasonCode, nextSafeAction: release.nextSafeAction, activeDeploymentReceiptFingerprint: release.activeDeploymentReceiptFingerprint, updatedAt: release.updatedAt })),
      attempts: attempts.map(attempt => ({ id: attempt.id, capability: attempt.capability, operation: attempt.operation, executionMode: attempt.executionMode, status: attempt.status, attemptNumber: attempt.attemptNumber, maxAttempts: attempt.maxAttempts, retryEligibleAt: attempt.retryEligibleAt, errorCode: attempt.errorCode, errorSummary: attempt.errorSummary, exactResponseIdentity: attempt.exactResponseIdentity, releaseId: attempt.releaseId, draftOrderId: attempt.draftOrderId })),
      receipts: receipts.map(receipt => ({ id: receipt.id, capability: receipt.capability, receiptType: receipt.receiptType, receiptStatus: receipt.receiptStatus, providerKey: receipt.providerKey, providerEventId: receipt.providerEventId, exactResponseIdentity: receipt.exactResponseIdentity, requestFingerprint: receipt.requestFingerprint, contentHash: receipt.contentHash, canonicalDomain: receipt.canonicalDomain, receiptFingerprint: receipt.receiptFingerprint, releaseId: receipt.releaseId, draftOrderId: receipt.draftOrderId, verifiedAt: receipt.verifiedAt })),
    }
  }))
  return {
    readiness,
    projects: projectRows,
    nextSafeActions: readiness.capabilities.filter(item => !item.liveMutationAllowed).map(item => ({ capability: item.capability, action: item.missing.includes('provider_configuration') ? 'configure_provider_reference' : item.missing.includes('credential_resolution') ? 'fix_server_credential_registry' : 'complete_server_provider_verification', blocked: true })),
    executionModes: { dryRun: true, mocked: readiness.mockedAllowed, live: readiness.liveReady },
    authority: { ownerOnly: true, browserCanClaimProviderSuccess: false, browserCanClaimPaymentSuccess: false, browserCanClaimDeploymentSuccess: false, sourceCodeDownload: false },
    limitations: [
      'No percentage, rank, ROI, payment, purchased-domain, TLS, deployment, or GEO outcome is inferred from an intent or caller response.',
      'Content Operations and measurement activate only after an exact verified live-site or existing-site ownership receipt.',
      'Provider credential values and raw webhook bodies are never projected.',
    ],
  }
}
