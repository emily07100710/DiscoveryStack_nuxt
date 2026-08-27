import type {
  ManagedSiteConnectorAttempt,
  ManagedSiteConnectorReceipt,
  ManagedSiteGenerationCandidate,
  ManagedSiteProviderConfiguration,
  ManagedSiteReleaseProjection,
} from '../../database/schema'

export const MANAGED_SITE_CONNECTOR_CAPABILITIES = ['website_generator', 'payment', 'domain_registration', 'dns_tls', 'deployment'] as const
export type ManagedSiteConnectorCapability = typeof MANAGED_SITE_CONNECTOR_CAPABILITIES[number]
export type ManagedSiteProviderReadinessStatus = 'disabled' | 'mock' | 'configured' | 'verified' | 'blocked'
export type ManagedSiteConnectorExecutionMode = 'dry_run' | 'mocked' | 'live'

export type ManagedSiteProviderConfigurationInput = {
  capability: ManagedSiteConnectorCapability
  providerKey: string
  readinessStatus: 'disabled' | 'mock' | 'configured'
  credentialReference?: string | null
  transportConfiguration?: Record<string, string | number | boolean | null>
  idempotencyKey: string
}

export type ManagedSiteProviderReadinessItem = {
  capability: ManagedSiteConnectorCapability
  providerKey: string | null
  status: ManagedSiteProviderReadinessStatus
  configured: boolean
  verified: boolean
  credentialReferenceConfigured: boolean
  credentialResolvable: boolean
  liveMutationAllowed: boolean
  missing: string[]
  blockedReasonCode: string | null
  verifiedAt: string | null
}

export type ManagedSiteProviderReadiness = {
  capabilities: ManagedSiteProviderReadinessItem[]
  liveReady: boolean
  dryRunAllowed: true
  mockedAllowed: boolean
  truthfulBoundary: string[]
}

export type ManagedSiteCredentialResolution =
  | { ok: true; value: string }
  | { ok: false; reason: 'registry_unavailable' | 'missing_reference' | 'invalid_reference' }

export type ManagedSiteCredentialResolver = (credentialReference: string) => ManagedSiteCredentialResolution | Promise<ManagedSiteCredentialResolution>

export type ManagedSiteGenerationRequest = {
  schemaVersion: 'managed-site-generation-request-v1'
  ownerUserId: number
  projectId: number
  sourceVersionId: number
  siteSpec: unknown
  brandContent: unknown
  locale: string
  selectedModules: string[]
  templateIntent: 'astro' | 'nuxt'
  geoBrief: unknown
  evidenceConstraints: {
    evidenceSnapshotHash: string
    authoritySourceIds: string[]
    limitations: string[]
    humanReviewRequired: true
  }
  requestFingerprint: string
  idempotencyKey: string
}

export type ManagedSiteGeneratedFile = {
  path: string
  mediaType: 'text/astro' | 'text/css' | 'text/html' | 'text/markdown' | 'application/json'
  content: string
  sha256: string
}

export type ManagedSiteGenerationProviderOutput = {
  schemaVersion: 'managed-site-generation-provider-response-v1'
  providerKey: string
  providerModel: string
  providerRequestId: string
  requestFingerprint: string
  files: ManagedSiteGeneratedFile[]
  manifestHash: string
}

export type ManagedSiteAdmittedManifest = {
  schemaVersion: 'managed-site-generation-manifest-v1'
  files: Array<{ path: string; mediaType: ManagedSiteGeneratedFile['mediaType']; byteSize: number; sha256: string }>
  fileCount: number
  totalBytes: number
  contentHash: string
  manifestHash: string
}

export type ManagedSiteGenerationAdapter = {
  generate(input: ManagedSiteGenerationRequest, context: {
    executionMode: ManagedSiteConnectorExecutionMode
    credentialReference: string | null
    resolveCredential: ManagedSiteCredentialResolver
    timeoutMs: number
    attemptNumber: number
  }): Promise<ManagedSiteGenerationProviderOutput>
}

export type ManagedSitePaymentEventType = 'checkout_succeeded' | 'checkout_failed' | 'checkout_cancelled' | 'payment_refunded'
export type ManagedSiteVerifiedPaymentWebhook = {
  providerKey: string
  providerEventId: string
  providerReference: string
  eventType: ManagedSitePaymentEventType
  draftOrderId: number
  amountMinor: number
  currency: string
  occurredAt: string
  exactResponseIdentity: string
  canonicalPayloadHash: string
}

export type ManagedSitePaymentWebhookAdapter = {
  verifyRawWebhook(input: {
    rawBody: Uint8Array
    signatureHeader: string
    credentialReference: string
    resolveCredential: ManagedSiteCredentialResolver
  }): Promise<ManagedSiteVerifiedPaymentWebhook | null>
}

export type ManagedSiteCheckoutSessionReceipt = {
  providerKey: string
  providerEventId: string
  providerReference: string
  checkoutUrl: string
  draftOrderId: number
  amountMinor: number
  currency: string
  snapshotFingerprint: string
  exactResponseIdentity: string
}

export type ManagedSiteCheckoutSessionAdapter = {
  createSession(input: { draftOrderId: number; quoteId: number; amountMinor: number; currency: string; planKey: string; cadenceDays: number; domainOption: string; lineSnapshot: Array<{ lineKey: string; quantity: number; unitAmountMinor: number; lineAmountMinor: number }>; taxStatus: string; snapshotFingerprint: string; idempotencyKey: string; timeoutMs: number }): Promise<ManagedSiteCheckoutSessionReceipt>
}

export type ManagedSiteDomainQuote = {
  providerKey: string
  quoteId: string
  canonicalDomain: string
  amountMinor: number
  currency: string
  expiresAt: string
  exactResponseIdentity: string
}

export type ManagedSiteDomainReceipt = {
  providerKey: string
  providerEventId: string
  providerReference: string
  canonicalDomain: string
  status: 'available' | 'unavailable' | 'purchase_intent_created' | 'registered'
  exactResponseIdentity: string
}

export type ManagedSiteDnsTlsReceipt = {
  providerKey: string
  providerEventId: string
  providerReference: string
  canonicalDomain: string
  dnsStatus: 'propagation_pending' | 'verified' | 'partial_failure'
  tlsStatus: 'pending' | 'verified' | 'failed'
  exactResponseIdentity: string
}

export type ManagedSiteDomainAdapter = {
  quote(input: { canonicalDomain: string; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDomainQuote>
  createPurchaseIntent(input: { quote: ManagedSiteDomainQuote; ownerConfirmationFingerprint: string; paymentReceiptFingerprint: string; idempotencyKey: string; timeoutMs: number }): Promise<ManagedSiteDomainReceipt>
}

export type ManagedSiteDnsTlsAdapter = {
  configureAndVerify(input: { canonicalDomain: string; projectId: number; releaseId: number; contentHash: string; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDnsTlsReceipt>
}

export type ManagedSiteDeploymentReceipt = {
  providerKey: string
  providerEventId: string
  providerDeploymentId: string
  projectId: number
  versionId: number
  contentHash: string
  canonicalDomain: string
  deploymentUrl: string
  status: 'preview_ready' | 'production_verified' | 'rollback_verified'
  exactResponseIdentity: string
}

export type ManagedSiteDeploymentAdapter = {
  buildPreview(input: { projectId: number; versionId: number; releaseId: number; vaultReference: string; contentHash: string; canonicalDomain: string; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDeploymentReceipt>
  deployProduction(input: { projectId: number; versionId: number; releaseId: number; vaultReference: string; contentHash: string; canonicalDomain: string; previewReceiptFingerprint: string; approvalFingerprint: string; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDeploymentReceipt>
  rollback(input: { projectId: number; fromReleaseId: number; toReleaseId: number; versionId: number; contentHash: string; canonicalDomain: string; priorDeploymentReceiptFingerprint: string; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDeploymentReceipt>
}

export type ManagedSiteExistingSiteOwnershipReceipt = {
  providerKey: string
  providerEventId: string
  providerReference: string
  canonicalDomain: string
  projectId: number
  verificationMethod: 'dns_txt' | 'well_known_file' | 'provider_account'
  evidenceHash: string
  status: 'verified' | 'pending' | 'failed'
  exactResponseIdentity: string
}

export type ManagedSiteExistingSiteOwnershipAdapter = {
  verify(input: { projectId: number; canonicalDomain: string; challengeReference: string; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteExistingSiteOwnershipReceipt>
}

export type ManagedSiteLiveConnectorRepository = {
  transaction<T>(work: (repository: ManagedSiteLiveConnectorRepository) => Promise<T>): Promise<T>
  findProviderConfiguration(ownerUserId: number, capability: ManagedSiteConnectorCapability): Promise<ManagedSiteProviderConfiguration | null>
  listProviderConfigurations(ownerUserId: number): Promise<ManagedSiteProviderConfiguration[]>
  findProviderConfigurationByFingerprint(ownerUserId: number, fingerprint: string): Promise<ManagedSiteProviderConfiguration | null>
  insertProviderConfiguration(input: Omit<ManagedSiteProviderConfiguration, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteProviderConfiguration>
  updateProviderConfiguration(id: number, patch: Partial<Omit<ManagedSiteProviderConfiguration, 'id' | 'ownerUserId' | 'capability' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteProviderConfiguration | null>
  findGenerationCandidate(ownerUserId: number, candidateId: number): Promise<ManagedSiteGenerationCandidate | null>
  findGenerationCandidateByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSiteGenerationCandidate | null>
  findGenerationCandidateByRequest(ownerUserId: number, requestFingerprint: string): Promise<ManagedSiteGenerationCandidate | null>
  insertGenerationCandidate(input: Omit<ManagedSiteGenerationCandidate, 'id' | 'createdAt'>): Promise<ManagedSiteGenerationCandidate>
  listGenerationCandidates(ownerUserId: number, projectId: number): Promise<ManagedSiteGenerationCandidate[]>
  findRelease(ownerUserId: number, releaseId: number): Promise<ManagedSiteReleaseProjection | null>
  findReleaseByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSiteReleaseProjection | null>
  insertRelease(input: Omit<ManagedSiteReleaseProjection, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteReleaseProjection>
  updateRelease(ownerUserId: number, releaseId: number, patch: Partial<Omit<ManagedSiteReleaseProjection, 'id' | 'ownerUserId' | 'projectId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteReleaseProjection | null>
  listReleases(ownerUserId: number, projectId: number): Promise<ManagedSiteReleaseProjection[]>
  findAttempt(ownerUserId: number, attemptId: number): Promise<ManagedSiteConnectorAttempt | null>
  findAttemptByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSiteConnectorAttempt | null>
  insertAttempt(input: Omit<ManagedSiteConnectorAttempt, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteConnectorAttempt>
  updateAttempt(ownerUserId: number, attemptId: number, patch: Partial<Omit<ManagedSiteConnectorAttempt, 'id' | 'ownerUserId' | 'projectId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteConnectorAttempt | null>
  acquireAttemptLease(ownerUserId: number, attemptId: number, leaseOwner: string, now: Date, leaseMs: number): Promise<ManagedSiteConnectorAttempt | null>
  releaseAttemptLease(ownerUserId: number, attemptId: number, leaseOwner: string, patch: Partial<Omit<ManagedSiteConnectorAttempt, 'id' | 'ownerUserId' | 'projectId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteConnectorAttempt | null>
  listAttempts(ownerUserId: number, projectId: number): Promise<ManagedSiteConnectorAttempt[]>
  findReceiptByProviderEvent(providerKey: string, providerEventId: string): Promise<ManagedSiteConnectorReceipt | null>
  findVerifiedDomainReceipt(canonicalDomain: string): Promise<ManagedSiteConnectorReceipt | null>
  findReceiptByFingerprint(ownerUserId: number, receiptFingerprint: string): Promise<ManagedSiteConnectorReceipt | null>
  insertReceipt(input: Omit<ManagedSiteConnectorReceipt, 'id'>): Promise<ManagedSiteConnectorReceipt>
  listReceipts(ownerUserId: number, projectId: number): Promise<ManagedSiteConnectorReceipt[]>
  listReceiptsByDraftOrder(ownerUserId: number, draftOrderId: number): Promise<ManagedSiteConnectorReceipt[]>
}
