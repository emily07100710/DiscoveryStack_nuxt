import { createHash } from 'node:crypto'
import { buildFirstPartyMarkdownArtifact } from './artifact'
import { isOpaqueReference, isRecord, isValidSha256, normalizeApprovedPublication, strictTimestamp, utf8ByteLength } from './normalization'
import { validateFirstPartyPublishTarget } from './target-guard'
import { FIRST_PARTY_COMMAND_VERSION, FIRST_PARTY_EXECUTOR_VERSION, FIRST_PARTY_PUBLISHING_RUNTIME_VERSION, type ApprovedFirstPartyPublication, type FirstPartyDecisionCode, type FirstPartyPlanResult, type FirstPartyPublishCommand, type FirstPartyPublishTarget, type FirstPartyPublicationIdentity, type FirstPartyTransport, type ValidatedFirstPartyTarget } from './types'

function blocked(code: FirstPartyDecisionCode, ...reasons: string[]): FirstPartyPlanResult {
  return { status: 'blocked', code, reasons }
}

function publicationIdentity(publication: ApprovedFirstPartyPublication): FirstPartyPublicationIdentity {
  return {
    publicationId: publication.productionDeliverableId,
    ownerScopeKey: publication.ownerScopeKey,
    scheduleEntryId: publication.scheduleEntryId,
    productionPlanId: publication.productionPlanId,
    productionDeliverableId: publication.productionDeliverableId,
    jobId: publication.jobId,
    draftId: publication.draftId,
    draftVersion: publication.draftVersion,
    reviewId: publication.reviewId,
    scheduleKey: publication.scheduleKey,
  }
}

export function computeDeliveryIdempotencyKey(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const targetId = input.targetId
  const ownerScopeKey = input.ownerScopeKey
  const framework = input.framework
  const transport = input.transport
  const targetOrigin = input.targetOrigin
  const contentRoot = input.contentRoot
  const branch = input.branch
  const repositoryOwner = input.repositoryOwner
  const repositoryName = input.repositoryName
  const endpointPath = input.endpointPath
  const path = input.path
  const publicationId = input.publicationId
  const productionDeliverableId = input.productionDeliverableId
  const scheduleEntryId = input.scheduleEntryId
  const productionPlanId = input.productionPlanId
  const jobId = input.jobId
  const draftId = input.draftId
  const draftVersion = input.draftVersion
  const reviewId = input.reviewId
  const scheduleKey = input.scheduleKey
  const evidenceSnapshotHash = input.evidenceSnapshotHash
  const contentHash = input.contentHash
  const artifactFingerprint = input.artifactFingerprint
  if (!isOpaqueReference(targetId) || !isOpaqueReference(ownerScopeKey) || (framework !== 'astro' && framework !== 'nuxt') || (transport !== 'first_party_git' && transport !== 'first_party_signed_api') || typeof targetOrigin !== 'string' || typeof contentRoot !== 'string' || typeof branch !== 'string' || typeof path !== 'string' || !isOpaqueReference(publicationId) || !isOpaqueReference(productionDeliverableId) || !isOpaqueReference(scheduleEntryId) || !isOpaqueReference(productionPlanId) || !isOpaqueReference(jobId) || !isOpaqueReference(draftId) || !Number.isSafeInteger(draftVersion) || (draftVersion as number) < 1 || !isOpaqueReference(reviewId) || !isOpaqueReference(scheduleKey, 256) || !isValidSha256(evidenceSnapshotHash) || !isValidSha256(contentHash) || !isValidSha256(artifactFingerprint)) return undefined
  if (repositoryOwner !== null && !isOpaqueReference(repositoryOwner)) return undefined
  if (repositoryName !== null && !isOpaqueReference(repositoryName)) return undefined
  if (endpointPath !== null && typeof endpointPath !== 'string') return undefined
  const payload = {
    runtimeVersion: FIRST_PARTY_PUBLISHING_RUNTIME_VERSION,
    targetId,
    ownerScopeKey,
    framework,
    transport,
    targetOrigin,
    contentRoot,
    branch,
    repositoryOwner,
    repositoryName,
    endpointPath,
    path,
    publicationId,
    productionDeliverableId,
    scheduleEntryId,
    productionPlanId,
    jobId,
    draftId,
    draftVersion,
    reviewId,
    scheduleKey,
    evidenceSnapshotHash: evidenceSnapshotHash.toLowerCase(),
    contentHash: contentHash.toLowerCase(),
    artifactFingerprint: artifactFingerprint.toLowerCase(),
  }
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

function isAllowed(target: ValidatedFirstPartyTarget, publication: ApprovedFirstPartyPublication): string | undefined {
  if (target.ownerScopeKey !== publication.ownerScopeKey) return 'target and publication owner scope do not match'
  if (!target.allowedContentTypes.includes(publication.contentType.toLowerCase())) return 'content type is not allowed by target'
  if (!target.allowedLanguages.includes(publication.language.toLowerCase())) return 'language is not allowed by target'
  return undefined
}

function validateArtifactHash(artifactContent: string, expectedHash: string): boolean {
  return createHash('sha256').update(artifactContent, 'utf8').digest('hex') === expectedHash
}

export function planFirstPartyPublication(targetInput: unknown, publicationInput: unknown, nowInput: unknown): FirstPartyPlanResult {
  try {
    const targetResult = validateFirstPartyPublishTarget(targetInput)
    if (targetResult.status === 'blocked') return targetResult
    const target = targetResult.target
    const publicationResult = normalizeApprovedPublication(publicationInput)
    if (!publicationResult.ok) {
      if (publicationResult.reason.includes('hash')) return blocked('INVALID_SHA256', publicationResult.reason)
      if (publicationResult.reason.includes('timestamp')) return blocked('INVALID_TIMESTAMP', publicationResult.reason)
      return blocked('PUBLICATION_NOT_APPROVED', publicationResult.reason)
    }
    const publication = publicationResult.publication
    const now = strictTimestamp(nowInput)
    if (!now.ok) return blocked('INVALID_TIMESTAMP', now.reason)
    const scheduled = strictTimestamp(publication.scheduledAt)
    if (!scheduled.ok) return blocked('INVALID_TIMESTAMP', scheduled.reason)
    if (scheduled.milliseconds > now.milliseconds) return blocked('SCHEDULED_IN_FUTURE', 'scheduledAt is later than injected now')
    const allowance = isAllowed(target, publication)
    if (allowance) return blocked(allowance.includes('owner') ? 'OWNER_SCOPE_MISMATCH' : allowance.includes('content') ? 'UNSUPPORTED_CONTENT_TYPE' : 'UNSUPPORTED_LANGUAGE', allowance)
    if (!isValidSha256(publication.evidenceSnapshotHash) || !isValidSha256(publication.contentHash)) return blocked('INVALID_SHA256', 'evidenceSnapshotHash and contentHash must be SHA-256')
    const artifactResult = buildFirstPartyMarkdownArtifact(target.contentRoot, publication)
    if (artifactResult.status === 'blocked') return artifactResult
    const artifact = artifactResult.artifact
    if (artifact.bytes > target.maximumPayloadBytes) return blocked('CONTENT_TOO_LARGE', 'serialized artifact exceeds target maximumPayloadBytes')
    if (!validateArtifactHash(artifact.body, publication.contentHash)) return blocked('CONTENT_HASH_MISMATCH', 'artifact body hash does not equal the approved contentHash')
    if (!isOpaqueReference(publication.productionDeliverableId) || !isOpaqueReference(target.targetId)) return blocked('IDEMPOTENCY_INVALID', 'publication identity is not opaque')
    const idempotencyKey = computeDeliveryIdempotencyKey({ targetId: target.targetId, ownerScopeKey: publication.ownerScopeKey, framework: target.framework, transport: target.transport, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, branch: target.defaultBranch, repositoryOwner: target.repositoryOwner, repositoryName: target.repositoryName, endpointPath: target.endpointPath, path: artifact.path, publicationId: publication.productionDeliverableId, productionDeliverableId: publication.productionDeliverableId, scheduleEntryId: publication.scheduleEntryId, productionPlanId: publication.productionPlanId, jobId: publication.jobId, draftId: publication.draftId, draftVersion: publication.draftVersion, reviewId: publication.reviewId, scheduleKey: publication.scheduleKey, evidenceSnapshotHash: publication.evidenceSnapshotHash, contentHash: publication.contentHash, artifactFingerprint: artifact.artifactFingerprint })
    if (!idempotencyKey) return blocked('IDEMPOTENCY_INVALID', 'complete publication identity could not be canonicalized')
    const identity = publicationIdentity(publication)
    const commitMessage = `publish:${publication.productionDeliverableId}:${publication.contentHash.slice(0, 12)}`
    const command: FirstPartyPublishCommand = {
      commandVersion: FIRST_PARTY_COMMAND_VERSION,
      targetId: target.targetId,
      ownerScopeKey: publication.ownerScopeKey,
      framework: target.framework,
      transport: target.transport,
      targetOrigin: target.targetOrigin,
      contentPath: artifact.path,
      publicationId: publication.productionDeliverableId,
      productionDeliverableId: publication.productionDeliverableId,
      contentHash: publication.contentHash,
      evidenceSnapshotHash: publication.evidenceSnapshotHash,
      artifactFingerprint: artifact.artifactFingerprint,
      idempotencyKey,
      attemptNumber: 1,
      commitMessage,
      branch: target.defaultBranch,
      provenance: {
        adapter: target.transport,
        framework: target.framework,
        transport: target.transport,
        artifactFingerprint: artifact.artifactFingerprint,
        credentialReference: target.credentialReference,
        executorVersion: FIRST_PARTY_EXECUTOR_VERSION,
        targetOrigin: target.targetOrigin,
        path: artifact.path,
        idempotencyKey,
      },
      limitations: ['metadata_only', 'not_delivered', 'executor_must_revalidate'],
    }
    return { status: 'planned', command, artifact: { ...artifact, publicationIdentity: identity } }
  } catch {
    return blocked('INVALID_INPUT', 'first-party publication plan input could not be safely read')
  }
}

export function commandBodyBytes(command: FirstPartyPublishCommand, body: string): number {
  return utf8ByteLength(body) + utf8ByteLength(JSON.stringify(command))
}

export function isFirstPartyCommand(value: unknown): value is FirstPartyPublishCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.commandVersion === FIRST_PARTY_COMMAND_VERSION && isOpaqueReference(record.targetId) && isOpaqueReference(record.publicationId) && isValidSha256(record.contentHash) && isValidSha256(record.evidenceSnapshotHash) && isValidSha256(record.artifactFingerprint) && isValidSha256(record.idempotencyKey)
}

export function commandTransport(command: FirstPartyPublishCommand): FirstPartyTransport {
  return command.transport
}

export type { FirstPartyPublishTarget }
