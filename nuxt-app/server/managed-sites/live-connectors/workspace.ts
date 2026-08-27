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
    const [candidates, releases, attempts, receipts, prePurchaseBinding] = await Promise.all([
      repository.listGenerationCandidates(ownerUserId, project.id),
      repository.listReleases(ownerUserId, project.id),
      repository.listAttempts(ownerUserId, project.id),
      repository.listReceipts(ownerUserId, project.id),
      repository.findPrePurchaseBinding(ownerUserId, project.id),
    ])
    const releaseRows = await Promise.all(releases.map(async release => {
      const gates = await repository.listGateResults(ownerUserId, release.id)
      const releaseReceipts = receipts.filter(receipt => receipt.releaseId === release.id)
      const hasPayment = releaseReceipts.some(receipt => receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified')
      const hasDomainQuote = releaseReceipts.some(receipt => receipt.receiptType === 'domain_quote_verified' && receipt.receiptStatus === 'verified')
      const hasOwnershipChallenge = releaseReceipts.some(receipt => receipt.receiptType === 'existing_site_challenge_created' && receipt.receiptStatus === 'verified')
      const domainClaim = await repository.findDomainClaim(release.canonicalDomain)
      const automatedGateTypes = ['artifact_admission', 'deterministic_compiler', 'preview_build', 'security_static_active_content', 'geo_content_structure']
      const gatesReady = automatedGateTypes.every(gateType => gates.some(gate => gate.gateType === gateType && gate.result === 'passed' && gate.contentHash === release.contentHash)) && gates.some(gate => gate.gateType === 'human_review' && gate.result === 'required' && gate.contentHash === release.contentHash)
      let effectiveNextSafeAction = release.nextSafeAction
      if (release.status === 'preview_ready' && gatesReady) effectiveNextSafeAction = 'approve_preview'
      if (release.status === 'checkout_pending' && hasPayment) effectiveNextSafeAction = 'bind_verified_payment'
      if (release.status === 'payment_verified' && !hasDomainQuote) effectiveNextSafeAction = 'quote_domain'
      if (release.status === 'payment_verified' && hasDomainQuote && domainClaim?.status !== 'verified') effectiveNextSafeAction = 'confirm_domain_purchase'
      if (release.status === 'payment_verified' && domainClaim?.status === 'verified') effectiveNextSafeAction = 'configure_dns_tls'
      if (release.releaseKind === 'existing_site' && release.status === 'candidate' && hasOwnershipChallenge) effectiveNextSafeAction = 'complete_existing_site_ownership_verification'
      return { id: release.id, releaseKind: release.releaseKind, versionId: release.versionId, generationCandidateId: release.generationCandidateId, previewId: release.previewId, quoteId: release.quoteId, draftOrderId: release.draftOrderId, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, targetKey: release.targetKey, canonicalDomain: release.canonicalDomain, contentHash: release.contentHash, status: release.status, previewUrl: release.previewUrl, approvalRecorded: Boolean(release.approvalFingerprint), blockedReasonCode: release.blockedReasonCode, nextSafeAction: effectiveNextSafeAction, activeDeploymentReceiptFingerprint: release.activeDeploymentReceiptFingerprint, gateResults: gates.map(gate => ({ gateType: gate.gateType, result: gate.result, reasonCodes: gate.reasonCodes, limitations: gate.limitations, receiptFingerprint: gate.receiptFingerprint, observedAt: gate.observedAt })), updatedAt: release.updatedAt }
    }))
    return {
      project: { id: project.id, canonicalClientIdentity: project.canonicalClientIdentity, canonicalWebsiteIdentity: project.canonicalWebsiteIdentity, status: project.status, siteType: project.siteType, activeVersionId: project.activeVersionId, contentOperationClientId: project.contentOperationClientId },
      prePurchaseBinding: prePurchaseBinding ? { sourceVersionId: prePurchaseBinding.sourceVersionId, previewId: prePurchaseBinding.previewId, quoteId: prePurchaseBinding.quoteId, draftOrderId: prePurchaseBinding.draftOrderId, commerceSnapshotFingerprint: prePurchaseBinding.commerceSnapshotFingerprint } : null,
      candidates: candidates.map(candidate => ({ id: candidate.id, sourceVersionId: candidate.sourceVersionId, providerKey: candidate.providerKey, providerModel: candidate.providerModel, manifestHash: candidate.manifestHash, contentHash: candidate.contentHash, gateSummary: candidate.gateSummary, storedInOwnerVault: true, sourceDownloadAvailable: false, createdAt: candidate.createdAt })),
      releases: releaseRows,
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
