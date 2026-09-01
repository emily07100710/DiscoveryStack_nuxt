import type {
  ManagedSiteConnectorAttempt,
  ManagedSiteConnectorReceipt,
  ManagedSiteDomainClaim,
  ManagedSiteGateResult,
  ManagedSiteGenerationCandidate,
  ManagedSiteProviderConfiguration,
  ManagedSitePrePurchaseBinding,
  ManagedSitePaymentWebhookInbox,
  ManagedSiteReleaseProjection,
} from '../../database/schema'

export const MANAGED_SITE_CONNECTOR_CAPABILITIES = ['website_generator', 'payment', 'domain_registration', 'dns_tls', 'deployment'] as const
export type ManagedSiteConnectorCapability = typeof MANAGED_SITE_CONNECTOR_CAPABILITIES[number]
export type ManagedSiteProviderReadinessStatus = 'disabled' | 'mock' | 'configured' | 'verified' | 'blocked'
export type ManagedSiteConnectorExecutionMode = 'dry_run' | 'mocked' | 'live'

/**
 * Canonical, non-sensitive authority carried by every provider mutation.
 * Credential references and values are deliberately excluded.
 */
export type ManagedSiteProviderAuthoritySnapshot = {
  schemaVersion: 'managed-site-provider-authority-v1'
  capability: ManagedSiteConnectorCapability
  providerKey: string
  configurationFingerprint: string
  verificationReceiptFingerprint: string
  capabilityIdentity: string
  readinessStatus: 'mock' | 'verified'
  executionMode: 'mocked' | 'live'
  verifiedAt: string | null
  authorityFingerprint: string
}

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

export type ManagedSiteBlueprintSectionV1 = {
  sectionId: string
  kind: 'hero' | 'summary' | 'services' | 'about' | 'contact' | 'blog_index' | 'shop_index' | 'faq' | 'module_slot'
  heading: string
  body: string
  ctaLabel: string | null
  ctaHref: string | null
  moduleKey: string | null
}

export type ManagedSiteBlueprintV1 = {
  schemaVersion: 'managed-site-blueprint-v1'
  brandName: string
  locale: 'en' | 'zh-hant'
  siteType: 'one_page' | 'brand_blog' | 'simple_commerce'
  navigation: Array<{ label: string; route: string }>
  pages: Array<{ pageKey: 'home' | 'about' | 'services' | 'faq' | 'contact' | 'blog' | 'shop'; route: string; title: string; description: string; sections: ManagedSiteBlueprintSectionV1[] }>
  faq: Array<{ question: string; answer: string }>
  selectedModulePlacements: Array<{ moduleKey: string; pageKey: string; sectionId: string; mode: 'safe_placeholder' | 'first_party' }>
  seoGeo: { summaryAnswer: string; canonicalPlaceholder: string; organizationName: string; evidenceLimitations: string[]; structuredDataKinds: Array<'Organization' | 'Service' | 'Product' | 'FAQPage'> }
  provenance: { evidenceSnapshotHash: string; authoritySourceIds: string[]; providerContentHash: string }
}

export type ManagedSiteBlueprintProviderOutput = {
  schemaVersion: 'managed-site-blueprint-provider-response-v1'
  providerKey: string
  providerModel: string
  providerRequestId: string
  requestFingerprint: string
  blueprint: ManagedSiteBlueprintV1
  blueprintHash: string
}

// The deterministic compiler output is intentionally separate from the model
// blueprint envelope. Only first-party code may construct this artifact shape.
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
  }): Promise<ManagedSiteBlueprintProviderOutput>
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
  configurationFingerprint: string
  verificationReceiptFingerprint: string
  checkoutReceiptFingerprint: string
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
  configurationFingerprint: string
  verificationReceiptFingerprint: string
  capabilityIdentity: string
  exactResponseIdentity: string
}

export type ManagedSiteCheckoutSessionAdapter = {
  createSession(input: { ownerUserId: number; projectId: number; releaseId: number; previewId: number; approvalFingerprint: string; draftOrderId: number; quoteId: number; amountMinor: number; currency: string; planKey: string; cadenceDays: number; domainOption: string; lineSnapshot: Array<{ lineKey: string; quantity: number; unitAmountMinor: number; lineAmountMinor: number }>; taxStatus: string; snapshotFingerprint: string; configurationFingerprint: string; verificationReceiptFingerprint: string; capabilityIdentity: string; idempotencyKey: string; timeoutMs: number }): Promise<ManagedSiteCheckoutSessionReceipt>
}

export type ManagedSiteDomainQuote = {
  providerKey: string
  quoteId: string
  canonicalDomain: string
  amountMinor: number
  currency: string
  expiresAt: string
  providerAuthorityFingerprint: string
  exactResponseIdentity: string
}

export type ManagedSiteDomainReceipt = {
  providerKey: string
  providerEventId: string
  providerReference: string
  canonicalDomain: string
  status: 'available' | 'unavailable' | 'purchase_intent_created' | 'registered'
  providerAuthorityFingerprint: string
  exactResponseIdentity: string
}

export type ManagedSiteDnsTlsReceipt = {
  providerKey: string
  providerEventId: string
  providerReference: string
  canonicalDomain: string
  dnsStatus: 'propagation_pending' | 'verified' | 'partial_failure'
  tlsStatus: 'pending' | 'verified' | 'failed'
  providerAuthorityFingerprint: string
  exactResponseIdentity: string
}

export type ManagedSiteDomainAdapter = {
  quote(input: { ownerUserId: number; projectId: number; releaseId: number; canonicalDomain: string; providerAuthority: ManagedSiteProviderAuthoritySnapshot; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDomainQuote>
  createPurchaseIntent(input: { ownerUserId: number; projectId: number; releaseId: number; draftOrderId: number; commerceSnapshotFingerprint: string; quote: ManagedSiteDomainQuote; providerAuthority: ManagedSiteProviderAuthoritySnapshot; ownerConfirmationFingerprint: string; paymentReceiptFingerprint: string; idempotencyKey: string; timeoutMs: number }): Promise<ManagedSiteDomainReceipt>
}

export type ManagedSiteDnsTlsAdapter = {
  configureAndVerify(input: { ownerUserId: number; canonicalDomain: string; projectId: number; releaseId: number; contentHash: string; providerAuthority: ManagedSiteProviderAuthoritySnapshot; requestFingerprint: string; idempotencyKey: string; timeoutMs: number }): Promise<ManagedSiteDnsTlsReceipt>
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
  observedAt: string
  payloadHash: string
  providerAuthorityFingerprint: string
  exactResponseIdentity: string
}

export type ManagedSiteDeploymentAdapter = {
  buildPreview(input: { projectId: number; versionId: number; releaseId: number; vaultReference: string; contentHash: string; canonicalDomain: string; providerAuthority: ManagedSiteProviderAuthoritySnapshot; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDeploymentReceipt>
  deployProduction(input: { projectId: number; versionId: number; releaseId: number; vaultReference: string; contentHash: string; canonicalDomain: string; previewReceiptFingerprint: string; approvalFingerprint: string; providerAuthority: ManagedSiteProviderAuthoritySnapshot; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDeploymentReceipt>
  rollback(input: { projectId: number; fromReleaseId: number; toReleaseId: number; versionId: number; contentHash: string; canonicalDomain: string; priorDeploymentReceiptFingerprint: string; providerAuthority: ManagedSiteProviderAuthoritySnapshot; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteDeploymentReceipt>
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
  providerAuthorityFingerprint: string
  exactResponseIdentity: string
}

export type ManagedSiteExistingSiteOwnershipAdapter = {
  createChallenge(input: { ownerUserId: number; projectId: number; releaseId: number; canonicalDomain: string; verificationMethod: 'dns_txt' | 'well_known_file' | 'provider_account'; providerAuthority: ManagedSiteProviderAuthoritySnapshot; requestFingerprint: string; idempotencyKey: string; timeoutMs: number }): Promise<{ providerKey: string; providerEventId: string; challengeReference: string; canonicalDomain: string; projectId: number; verificationMethod: 'dns_txt' | 'well_known_file' | 'provider_account'; providerAuthorityFingerprint: string; exactResponseIdentity: string }>
  verify(input: { projectId: number; canonicalDomain: string; challengeReference: string; providerAuthority: ManagedSiteProviderAuthoritySnapshot; requestFingerprint: string; timeoutMs: number }): Promise<ManagedSiteExistingSiteOwnershipReceipt>
}

export type ManagedSiteLiveConnectorRepository = {
  transaction<T>(work: (repository: ManagedSiteLiveConnectorRepository) => Promise<T>): Promise<T>
  findProviderConfiguration(ownerUserId: number, capability: ManagedSiteConnectorCapability): Promise<ManagedSiteProviderConfiguration | null>
  listProviderConfigurations(ownerUserId: number): Promise<ManagedSiteProviderConfiguration[]>
  findProviderConfigurationByFingerprint(ownerUserId: number, fingerprint: string): Promise<ManagedSiteProviderConfiguration | null>
  insertProviderConfiguration(input: Omit<ManagedSiteProviderConfiguration, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteProviderConfiguration>
  updateProviderConfiguration(ownerUserId: number, id: number, patch: Partial<Omit<ManagedSiteProviderConfiguration, 'id' | 'ownerUserId' | 'capability' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteProviderConfiguration | null>
  verifyProviderConfigurationCas(ownerUserId: number, id: number, expectedFingerprint: string, patch: Partial<Omit<ManagedSiteProviderConfiguration, 'id' | 'ownerUserId' | 'capability' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteProviderConfiguration | null>
  findPrePurchaseBinding(ownerUserId: number, projectId: number): Promise<ManagedSitePrePurchaseBinding | null>
  findPrePurchaseBindingByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSitePrePurchaseBinding | null>
  insertPrePurchaseBinding(input: Omit<ManagedSitePrePurchaseBinding, 'id' | 'createdAt'>): Promise<ManagedSitePrePurchaseBinding>
  findGenerationCandidate(ownerUserId: number, candidateId: number): Promise<ManagedSiteGenerationCandidate | null>
  findGenerationCandidateByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSiteGenerationCandidate | null>
  findGenerationCandidateByRequest(ownerUserId: number, requestFingerprint: string): Promise<ManagedSiteGenerationCandidate | null>
  insertGenerationCandidate(input: Omit<ManagedSiteGenerationCandidate, 'id' | 'createdAt'>): Promise<ManagedSiteGenerationCandidate>
  listGenerationCandidates(ownerUserId: number, projectId: number): Promise<ManagedSiteGenerationCandidate[]>
  findRelease(ownerUserId: number, releaseId: number): Promise<ManagedSiteReleaseProjection | null>
  findReleaseByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSiteReleaseProjection | null>
  insertRelease(input: Omit<ManagedSiteReleaseProjection, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteReleaseProjection>
  transitionRelease(ownerUserId: number, releaseId: number, expectedStatus: ManagedSiteReleaseProjection['status'], expectedProjectionFingerprint: string, patch: Partial<Omit<ManagedSiteReleaseProjection, 'id' | 'ownerUserId' | 'projectId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteReleaseProjection | null>
  listReleases(ownerUserId: number, projectId: number): Promise<ManagedSiteReleaseProjection[]>
  insertGateResult(input: Omit<ManagedSiteGateResult, 'id'>): Promise<ManagedSiteGateResult>
  listGateResults(ownerUserId: number, releaseId: number): Promise<ManagedSiteGateResult[]>
  findDomainClaim(canonicalDomain: string): Promise<ManagedSiteDomainClaim | null>
  findDomainClaimByRelease(ownerUserId: number, releaseId: number): Promise<ManagedSiteDomainClaim | null>
  findDomainClaimByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSiteDomainClaim | null>
  insertDomainClaim(input: Omit<ManagedSiteDomainClaim, 'id' | 'createdAt' | 'updatedAt' | 'activeCanonicalDomainKey'>): Promise<ManagedSiteDomainClaim>
  transitionDomainClaim(ownerUserId: number, claimId: number, expectedStatus: ManagedSiteDomainClaim['status'], expectedProjectionFingerprint: string, patch: Partial<Omit<ManagedSiteDomainClaim, 'id' | 'ownerUserId' | 'canonicalDomain' | 'activeCanonicalDomainKey' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteDomainClaim | null>
  findPaymentWebhookInbox(providerKey: string, providerEventId: string): Promise<ManagedSitePaymentWebhookInbox | null>
  insertPaymentWebhookInbox(input: Omit<ManagedSitePaymentWebhookInbox, 'id' | 'receivedAt'>): Promise<ManagedSitePaymentWebhookInbox>
  transitionPaymentWebhookInbox(inboxId: number, expectedStatus: ManagedSitePaymentWebhookInbox['processingStatus'], expectedProcessingFingerprint: string, patch: Partial<Omit<ManagedSitePaymentWebhookInbox, 'id' | 'providerKey' | 'providerEventId' | 'eventFingerprint' | 'receivedAt'>>): Promise<ManagedSitePaymentWebhookInbox | null>
  findAttempt(ownerUserId: number, attemptId: number): Promise<ManagedSiteConnectorAttempt | null>
  findAttemptByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ManagedSiteConnectorAttempt | null>
  insertAttempt(input: Omit<ManagedSiteConnectorAttempt, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteConnectorAttempt>
  updateAttempt(ownerUserId: number, attemptId: number, patch: Partial<Omit<ManagedSiteConnectorAttempt, 'id' | 'ownerUserId' | 'projectId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteConnectorAttempt | null>
  acquireAttemptLease(ownerUserId: number, attemptId: number, leaseOwner: string, now: Date, leaseMs: number): Promise<ManagedSiteConnectorAttempt | null>
  releaseAttemptLease(ownerUserId: number, attemptId: number, leaseOwner: string, patch: Partial<Omit<ManagedSiteConnectorAttempt, 'id' | 'ownerUserId' | 'projectId' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteConnectorAttempt | null>
  listAttempts(ownerUserId: number, projectId: number): Promise<ManagedSiteConnectorAttempt[]>
  listEligibleRetryAttempts(now: Date, limit: number, ownerUserId?: number): Promise<ManagedSiteConnectorAttempt[]>
  findReceiptByProviderEvent(providerKey: string, providerEventId: string): Promise<ManagedSiteConnectorReceipt | null>
  findVerifiedDomainReceipt(canonicalDomain: string): Promise<ManagedSiteConnectorReceipt | null>
  findReceiptByFingerprint(ownerUserId: number, receiptFingerprint: string): Promise<ManagedSiteConnectorReceipt | null>
  findOwnershipChallengeByReference(projectId: number, canonicalDomain: string, challengeReference: string): Promise<ManagedSiteConnectorReceipt | null>
  insertReceipt(input: Omit<ManagedSiteConnectorReceipt, 'id'>): Promise<ManagedSiteConnectorReceipt>
  listReceipts(ownerUserId: number, projectId: number): Promise<ManagedSiteConnectorReceipt[]>
  listReceiptsByDraftOrder(ownerUserId: number, draftOrderId: number): Promise<ManagedSiteConnectorReceipt[]>
}
