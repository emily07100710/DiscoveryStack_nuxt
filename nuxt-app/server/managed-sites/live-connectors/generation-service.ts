import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { getManagedSiteRepository } from '../repository'
import { parseSiteSpecSnapshot } from '../site-spec'
import type { ManagedSiteRepository } from '../types'
import { admitManagedSiteGenerationOutput } from './generation-artifact'
import { blueprintCompilerFingerprint, compileManagedSiteBlueprint, validateManagedSiteBlueprintProviderOutput } from './blueprint'
import { getManagedSiteLiveConnectorRepository } from './repository'
import { requireVerifiedManagedSiteProvider, resolveManagedSiteCredential } from './provider-registry'
import type {
  ManagedSiteAdmittedManifest,
  ManagedSiteConnectorExecutionMode,
  ManagedSiteCredentialResolver,
  ManagedSiteGeneratedFile,
  ManagedSiteGenerationAdapter,
  ManagedSiteGenerationRequest,
  ManagedSiteLiveConnectorRepository,
} from './types'

const REQUEST_SCHEMA_VERSION = 'managed-site-generation-request-v1' as const
const GENERATION_TIMEOUT_MS = 30_000
const GENERATION_LEASE_MS = 45_000
const GENERATION_MAX_ATTEMPTS = 3

export type ManagedSiteArtifactVault = {
  storeImmutableCandidate(input: {
    ownerUserId: number
    projectId: number
    requestFingerprint: string
    manifest: ManagedSiteAdmittedManifest
    files: readonly ManagedSiteGeneratedFile[]
  }): Promise<{ vaultReference: string; contentHash: string; exactResponseIdentity: string }>
}

export const FAIL_CLOSED_MANAGED_SITE_ARTIFACT_VAULT: ManagedSiteArtifactVault = {
  async storeImmutableCandidate() { throw createError({ statusCode: 503, statusMessage: 'Managed-site owner artifact vault is not configured.' }) },
}

export type GenerateManagedSiteCandidateInput = {
  projectId: number
  sourceVersionId: number
  templateIntent: 'astro' | 'nuxt'
  executionMode: ManagedSiteConnectorExecutionMode
  idempotencyKey: string
}

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function unavailable(message: string): never { throw createError({ statusCode: 503, statusMessage: message }) }

function retryAt(attemptNumber: number, now: Date): Date | null {
  if (attemptNumber >= GENERATION_MAX_ATTEMPTS) return null
  return new Date(now.getTime() + (attemptNumber === 1 ? 5 : 30) * 60_000)
}

function boundedTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('managed-site generation timeout'), { code: 'TIMEOUT', retryable: true })), timeoutMs)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function safeError(error: unknown): { code: string; summary: string; retryable: boolean } {
  const candidate = error as { code?: unknown; retryable?: unknown; statusCode?: unknown }
  const code = typeof candidate?.code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(candidate.code) ? candidate.code : Number(candidate?.statusCode) === 422 ? 'ARTIFACT_REJECTED' : 'GENERATION_FAILED'
  return { code, summary: code === 'TIMEOUT' ? 'Provider request timed out before an admissible candidate was stored.' : code === 'ARTIFACT_REJECTED' ? 'Provider output failed strict artifact admission.' : 'Provider execution failed without storing a candidate.', retryable: candidate?.retryable === true || code === 'TIMEOUT' }
}

export function buildManagedSiteGenerationRequest(ownerUserId: number, projectId: number, sourceVersionId: number, versionFingerprint: string, siteSpecInput: unknown, templateIntent: 'astro' | 'nuxt', idempotencyKey: string): ManagedSiteGenerationRequest {
  if (![ownerUserId, projectId, sourceVersionId].every(value => Number.isSafeInteger(value) && value > 0)) invalid('Generation lineage identity is invalid.')
  if (!isOpaqueReference(idempotencyKey, 128)) invalid('Generation idempotency key is invalid.')
  const siteSpec = parseSiteSpecSnapshot(siteSpecInput)
  const authoritySourceIds = siteSpec.approvedEvidenceReferences.map(reference => `source:${reference.sourceId}${reference.artifactId ? `:artifact:${reference.artifactId}` : ''}`).sort()
  const evidenceSnapshotHash = siteSpec.contentProvenance.evidenceSnapshotHash || stableFingerprint({ source: 'validated_customer_brief', businessIdentity: siteSpec.businessIdentity, siteSpecFingerprint: siteSpec.deterministicFingerprint })
  const identity = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    ownerUserId,
    projectId,
    sourceVersionId,
    versionFingerprint,
    siteSpecFingerprint: siteSpec.deterministicFingerprint,
    locale: siteSpec.locale,
    selectedModules: [...siteSpec.selectedModules].sort(),
    templateIntent,
    evidenceSnapshotHash,
    authoritySourceIds,
  }
  const requestFingerprint = stableFingerprint(identity)
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    ownerUserId,
    projectId,
    sourceVersionId,
    siteSpec,
    brandContent: siteSpec.businessIdentity,
    locale: siteSpec.locale,
    selectedModules: [...siteSpec.selectedModules].sort(),
    templateIntent,
    geoBrief: { structuralRequirements: siteSpec.seoGeoStructuralRequirements, diagnosisBinding: siteSpec.diagnosisBinding, contentProvenance: siteSpec.contentProvenance },
    evidenceConstraints: { evidenceSnapshotHash, authoritySourceIds, limitations: [...siteSpec.limitations], humanReviewRequired: true },
    requestFingerprint,
    idempotencyKey,
  }
}

export async function generateManagedSiteCandidate(
  ownerUserId: number,
  input: GenerateManagedSiteCandidateInput,
  dependencies: {
    adapter?: ManagedSiteGenerationAdapter
    vault?: ManagedSiteArtifactVault
    credentialResolver?: ManagedSiteCredentialResolver
    repository?: ManagedSiteLiveConnectorRepository
    managedRepository?: ManagedSiteRepository
    clock?: () => Date
  } = {},
) {
  if (input.templateIntent !== 'astro') invalid('Managed-site generation V1 admits the fixed Astro template surface only.')
  if (!['dry_run', 'mocked', 'live'].includes(input.executionMode)) invalid('Generation execution mode is invalid.')
  if (input.executionMode === 'mocked' && process.env.NODE_ENV !== 'test') unavailable('Mocked managed-site generation is restricted to tests.')
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const credentialResolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const project = await managedRepository.findProject(ownerUserId, input.projectId)
  const version = await managedRepository.findVersion(ownerUserId, input.sourceVersionId)
  if (!project || !version || version.projectId !== project.id) throw createError({ statusCode: 404, statusMessage: 'Managed-site generation lineage was not found.' })
  if (project.status === 'suspended') conflict('Suspended projects cannot create generation candidates.')
  if (!['active', 'preview', 'draft'].includes(version.lifecycleStatus)) conflict('Generation requires a current managed-site version snapshot.')
  const request = buildManagedSiteGenerationRequest(ownerUserId, project.id, version.id, version.versionFingerprint, version.siteSpecSnapshot, input.templateIntent, input.idempotencyKey)
  const replay = await repository.findGenerationCandidateByIdempotency(ownerUserId, input.idempotencyKey)
  if (replay) {
    if (replay.requestFingerprint !== request.requestFingerprint) conflict('Generation idempotency key was already used for another immutable request.')
    return { candidate: replay, replayed: true, executionMode: input.executionMode }
  }
  const collision = await repository.findGenerationCandidateByRequest(ownerUserId, request.requestFingerprint)
  if (collision) conflict('Generation request already exists under a different idempotency key.')
  const configured = await repository.findProviderConfiguration(ownerUserId, 'website_generator')
  if (input.executionMode === 'live') await requireVerifiedManagedSiteProvider(ownerUserId, 'website_generator', repository, credentialResolver)
  if (input.executionMode === 'mocked' && configured?.readinessStatus !== 'mock' && configured?.readinessStatus !== 'verified') unavailable('Mocked generation requires an explicit test-only mock provider configuration.')
  const providerKey = configured?.providerKey || 'unconfigured'
  const attemptFingerprint = stableFingerprint({ ownerUserId, projectId: project.id, operation: 'generate_candidate', requestFingerprint: request.requestFingerprint, providerKey, executionMode: input.executionMode })
  const attemptKey = stableFingerprint({ operation: 'generate_candidate', idempotencyKey: input.idempotencyKey })
  let attempt = await repository.findAttemptByIdempotency(ownerUserId, attemptKey)
  if (attempt && attempt.requestFingerprint !== attemptFingerprint) conflict('Generation attempt idempotency collision detected.')
  if (!attempt) attempt = await repository.insertAttempt({ ownerUserId, projectId: project.id, draftOrderId: null, releaseId: null, capability: 'website_generator', operation: 'generate_candidate', executionMode: input.executionMode === 'live' ? 'live' : input.executionMode, status: 'queued', attemptNumber: 0, maxAttempts: GENERATION_MAX_ATTEMPTS, timeoutMs: GENERATION_TIMEOUT_MS, requestFingerprint: attemptFingerprint, idempotencyKey: attemptKey, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: null, errorCode: null, errorSummary: null } as any)
  if (input.executionMode === 'dry_run') {
    if (attempt.status === 'queued') await repository.updateAttempt(ownerUserId, attempt.id, { status: 'succeeded', exactResponseIdentity: `dry-run:${request.requestFingerprint}`, attemptNumber: 0 })
    return { candidate: null, replayed: false, executionMode: 'dry_run' as const, request: { schemaVersion: request.schemaVersion, requestFingerprint: request.requestFingerprint, projectId: request.projectId, sourceVersionId: request.sourceVersionId, templateIntent: request.templateIntent }, limitations: ['No provider, vault, preview, deployment, DNS, payment, or customer-site mutation was executed.'] }
  }
  if (!dependencies.adapter) unavailable('Managed-site generation adapter is not injected.')
  if (!dependencies.vault) unavailable('Managed-site artifact vault is not injected.')
  const now = clock()
  const leaseOwner = `generation-${randomBytes(12).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, now, GENERATION_LEASE_MS)
  if (!leased) conflict('Generation attempt is already leased, terminal, or waiting for its retry window.')
  const attemptNumber = leased.attemptNumber + 1
  try {
    const output = await boundedTimeout(dependencies.adapter.generate(request, { executionMode: input.executionMode, credentialReference: configured?.credentialReference || null, resolveCredential: credentialResolver, timeoutMs: GENERATION_TIMEOUT_MS, attemptNumber }), GENERATION_TIMEOUT_MS)
    const structured = validateManagedSiteBlueprintProviderOutput(output, request, providerKey)
    const compiledFiles = compileManagedSiteBlueprint(structured.blueprint)
    const compilerFingerprint = blueprintCompilerFingerprint(structured.blueprint, compiledFiles)
    const admitted = admitManagedSiteGenerationOutput({ schemaVersion: 'managed-site-generation-provider-response-v1', providerKey: structured.output.providerKey, providerModel: structured.output.providerModel, providerRequestId: structured.output.providerRequestId, requestFingerprint: request.requestFingerprint, files: compiledFiles, manifestHash: stableFingerprint(compiledFiles.map(file => ({ path: file.path, mediaType: file.mediaType, sha256: file.sha256 })).sort((left, right) => left.path.localeCompare(right.path))) }, { requestFingerprint: request.requestFingerprint, providerKey })
    const stored = await dependencies.vault.storeImmutableCandidate({ ownerUserId, projectId: project.id, requestFingerprint: request.requestFingerprint, manifest: admitted.manifest, files: admitted.files })
    if (!/^vault:[A-Za-z0-9_.:-]{1,500}$/u.test(stored.vaultReference) || stored.contentHash !== admitted.manifest.contentHash || !isOpaqueReference(stored.exactResponseIdentity, 256)) conflict('Owner vault receipt identity is incomplete or mismatched.')
    const candidate = await repository.transaction(async transaction => {
      const created = await transaction.insertGenerationCandidate({ ownerUserId, projectId: project.id, sourceVersionId: version.id, requestSchemaVersion: request.schemaVersion, requestFingerprint: request.requestFingerprint, idempotencyKey: input.idempotencyKey, providerKey: admitted.output.providerKey, providerModel: admitted.output.providerModel, providerRequestId: admitted.output.providerRequestId, manifest: { ...admitted.manifest, blueprintHash: structured.blueprintHash, compilerFingerprint, blueprint: structured.blueprint }, manifestHash: admitted.manifest.manifestHash, contentHash: admitted.manifest.contentHash, vaultReference: stored.vaultReference, gateSummary: { artifactAdmission: 'passed', deterministicCompiler: 'passed', previewBuild: 'not_run', securityStaticActiveContent: 'not_run', geoContentStructure: 'not_run', humanReview: 'required' } } as any)
      const receiptFingerprint = stableFingerprint({ ownerUserId, projectId: project.id, capability: 'website_generator', providerKey, providerEventId: admitted.output.providerRequestId, requestFingerprint: request.requestFingerprint, contentHash: admitted.manifest.contentHash, manifestHash: admitted.manifest.manifestHash, vaultIdentity: stored.exactResponseIdentity })
      await transaction.insertReceipt({ ownerUserId, projectId: project.id, draftOrderId: null, releaseId: null, attemptId: leased.id, capability: 'website_generator', providerKey, providerEventId: admitted.output.providerRequestId, receiptType: 'generation_candidate_admitted', receiptStatus: 'verified', externalReference: stored.vaultReference, exactResponseIdentity: stored.exactResponseIdentity, requestFingerprint: request.requestFingerprint, contentHash: admitted.manifest.contentHash, canonicalDomain: null, metadata: { manifestHash: admitted.manifest.manifestHash, blueprintHash: structured.blueprintHash, compilerFingerprint, providerModel: admitted.output.providerModel, fileCount: admitted.manifest.fileCount, totalBytes: admitted.manifest.totalBytes }, receiptFingerprint, verifiedAt: clock() } as any)
      return created
    })
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber, retryEligibleAt: null, exactResponseIdentity: admitted.output.providerRequestId, errorCode: null, errorSummary: null })
    return { candidate, replayed: false, executionMode: input.executionMode, nextSafeAction: 'run_preview_build_and_security_gates' }
  } catch (error) {
    const safe = safeError(error)
    const nextRetry = safe.retryable ? retryAt(attemptNumber, clock()) : null
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: nextRetry ? 'retry_wait' : safe.retryable ? 'failed' : 'blocked', attemptNumber, retryEligibleAt: nextRetry, exactResponseIdentity: null, errorCode: safe.code, errorSummary: safe.summary }).catch(() => null)
    throw error instanceof Error && 'statusCode' in error ? error : createError({ statusCode: safe.retryable ? 503 : 422, statusMessage: safe.summary })
  }
}
