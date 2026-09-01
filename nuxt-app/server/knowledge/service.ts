import { createHash } from 'node:crypto'
import { generateUlid } from './ulid'
import type {
  CreateKnowledgeClaimInput,
  CreateKnowledgeEntityInput,
  ExactEntityMatch,
  KnowledgeClaim,
  KnowledgeClaimDispute,
  KnowledgeClaimStatus,
  KnowledgeContentEntityLink,
  KnowledgeContentEntityRole,
  KnowledgeContentGap,
  KnowledgeEntity,
  KnowledgeEntityAlias,
  KnowledgeEntityExternalId,
  KnowledgeEntityMergeCandidate,
  KnowledgeEntityMergeEvent,
  KnowledgeEvidenceRelation,
  KnowledgeRepository,
  KnowledgeResult,
  KnowledgeSourceClass,
} from './types'

function ok<T>(value: T): KnowledgeResult<T> { return { status: 'ok', value } }
function rejected(code: Parameters<typeof rejectCode>[0], reason: string, extra: Partial<{ existingEntityId: number; matchedOn: ExactEntityMatch }> = {}): ReturnType<typeof rejectCode> { return rejectCode(code, reason, extra) }
function rejectCode(code: import('./types').KnowledgeDecisionCode, reason: string, extra: Partial<{ existingEntityId: number; matchedOn: ExactEntityMatch }> = {}): import('./types').KnowledgeRejectedResult { return { status: 'rejected', code, reason, ...extra } }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function bounded(value: string, maximum: number): boolean { return value.length >= 1 && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) }
function validHash(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value) }

/** trim + lowercase + full-width ASCII folding + Unicode-space collapse. */
export function normalizeKnowledgeName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u3000/gu, ' ')
    .trim()
    .toLocaleLowerCase('und')
    .replace(/\s+/gu, ' ')
}

export function normalizeKnowledgeUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim())
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    parsed.hash = ''
    parsed.hostname = parsed.hostname.toLowerCase()
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = ''
    const entries = [...parsed.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    parsed.search = ''
    for (const [key, entryValue] of entries) parsed.searchParams.append(key, entryValue)
    return parsed.href
  } catch {
    return null
  }
}

function normalizeCanonicalUri(value: string): string | null {
  const trimmed = value.trim()
  if (!bounded(trimmed, 500)) return null
  return normalizeKnowledgeUrl(trimmed) ?? trimmed
}

const DISPUTABLE_STATUSES: readonly KnowledgeClaimStatus[] = ['unverified', 'source_backed', 'independently_confirmed', 'first_party_measured']
const ORGANIZATION_ENTITY_TYPES = new Set<KnowledgeEntity['entityType']>(['Organization', 'Brand'])

export interface KnowledgeServiceOptions {
  readonly ownerUserId: number
  readonly repository: KnowledgeRepository
  readonly now?: () => Date
  readonly entityUid?: () => string
}

export class KnowledgeService {
  readonly ownerUserId: number
  private readonly repository: KnowledgeRepository
  private readonly clock: () => Date
  private readonly nextEntityUid: () => string

  constructor(options: KnowledgeServiceOptions) {
    if (!Number.isSafeInteger(options.ownerUserId) || options.ownerUserId <= 0) throw new Error('ownerUserId must be a positive server-derived integer.')
    this.ownerUserId = options.ownerUserId
    this.repository = options.repository
    this.clock = options.now ?? (() => new Date())
    this.nextEntityUid = options.entityUid ?? generateUlid
  }

  private timestamp(): Date { return new Date(this.clock()) }

  private async resolveWith(repository: KnowledgeRepository, entityId: number): Promise<KnowledgeResult<KnowledgeEntity>> {
    const visited = new Set<number>()
    let currentId = entityId
    for (let hop = 0; hop <= 10; hop += 1) {
      if (visited.has(currentId)) return rejected('MERGE_CYCLE', 'Entity merge redirect contains a cycle.')
      visited.add(currentId)
      const entity = await repository.getEntity(this.ownerUserId, currentId)
      if (!entity) return rejected('ENTITY_NOT_FOUND', 'Entity does not exist for this owner.')
      if (entity.status !== 'merged') return ok(entity)
      if (entity.mergedIntoEntityId === null) return rejected('MERGE_CYCLE', 'Merged entity has no canonical redirect.')
      currentId = entity.mergedIntoEntityId
    }
    return rejected('MERGE_CYCLE', 'Entity merge redirect exceeded the ten-hop safety bound.')
  }

  async resolveEntity(entityId: number): Promise<KnowledgeResult<KnowledgeEntity>> {
    return this.resolveWith(this.repository, entityId)
  }

  private async findExactMatch(repository: KnowledgeRepository, canonicalUri: string | null, externalIds: readonly { idType: string; idValue: string }[]): Promise<{ entity: KnowledgeEntity; matchedOn: ExactEntityMatch } | null> {
    const allExternalIds = await repository.listEntityExternalIds(this.ownerUserId)
    for (const externalId of externalIds) {
      const match = allExternalIds.find(item => item.idType === externalId.idType && item.idValue === externalId.idValue)
      if (!match) continue
      const resolved = await this.resolveWith(repository, match.entityId)
      if (resolved.status === 'ok') return { entity: resolved.value, matchedOn: { method: 'exact_external_id', idType: externalId.idType, idValue: externalId.idValue } }
    }
    if (canonicalUri !== null) {
      const hash = sha256(canonicalUri)
      const match = (await repository.listEntities(this.ownerUserId)).find(item => item.canonicalUriHash === hash)
      if (match) {
        const resolved = await this.resolveWith(repository, match.id)
        if (resolved.status === 'ok') return { entity: resolved.value, matchedOn: { method: 'exact_canonical_uri', canonicalUri } }
      }
    }
    return null
  }

  async createEntity(input: CreateKnowledgeEntityInput): Promise<KnowledgeResult<{ entity: KnowledgeEntity; mergeCandidates: KnowledgeEntityMergeCandidate[] }>> {
    const canonicalName = input.canonicalName?.trim()
    if (!canonicalName || !bounded(canonicalName, 255)) return rejected('INVALID_INPUT', 'canonicalName must be a bounded non-empty string.')
    const canonicalUri = input.canonicalUri === undefined ? null : normalizeCanonicalUri(input.canonicalUri)
    if (input.canonicalUri !== undefined && canonicalUri === null) return rejected('INVALID_INPUT', 'canonicalUri must be a bounded URI or HTTP(S) URL.')
    const normalizedExternalIds = (input.externalIds ?? []).map(item => ({ idType: item.idType.trim(), idValue: item.idValue.trim() }))
    const externalIds = [...new Map(normalizedExternalIds.map(item => [`${item.idType}\u0000${item.idValue}`, item])).values()]
    if (externalIds.some(item => !bounded(item.idType, 64) || !bounded(item.idValue, 255))) return rejected('INVALID_INPUT', 'External identifiers must have bounded non-empty type and value fields.')
    const aliases = [...new Map((input.aliases ?? []).map(item => [normalizeKnowledgeName(item.alias), { alias: item.alias.trim(), locale: item.locale?.trim() || null }])).values()]
    if (aliases.some(item => !bounded(item.alias, 255) || !normalizeKnowledgeName(item.alias))) return rejected('INVALID_INPUT', 'Aliases must be bounded non-empty strings.')

    return this.repository.transaction(async repository => {
      const exact = await this.findExactMatch(repository, canonicalUri, externalIds)
      if (exact) return rejected('DUPLICATE_ENTITY', 'An exact owner-scoped entity identity already exists.', { existingEntityId: exact.entity.id, matchedOn: exact.matchedOn })
      const beforeEntities = await repository.listEntities(this.ownerUserId)
      const beforeAliases = await repository.listEntityAliases(this.ownerUserId)
      const normalizedName = normalizeKnowledgeName(canonicalName)
      const matchedEntityIds = new Set<number>()
      for (const entity of beforeEntities) if (normalizeKnowledgeName(entity.canonicalName) === normalizedName) matchedEntityIds.add(entity.id)
      for (const alias of beforeAliases) if (alias.aliasNormalized === normalizedName) matchedEntityIds.add(alias.entityId)

      const now = this.timestamp()
      const entity = await repository.insertEntity({
        ownerUserId: this.ownerUserId,
        entityUid: this.nextEntityUid(),
        entityType: input.entityType,
        canonicalName,
        slug: input.slug?.trim() || null,
        canonicalUri,
        canonicalUriHash: canonicalUri === null ? null : sha256(canonicalUri),
        locale: input.locale?.trim() || null,
        summary: input.summary?.trim() || null,
        status: 'active',
        publicVisibility: input.publicVisibility ?? 'private',
        mergedIntoEntityId: null,
        provenance: input.provenance ?? null,
        createdAt: now,
        updatedAt: now,
      })
      for (const externalId of externalIds) await repository.insertEntityExternalId({ ownerUserId: this.ownerUserId, entityId: entity.id, ...externalId, createdAt: now, updatedAt: now })
      for (const alias of aliases) await repository.insertEntityAlias({ ownerUserId: this.ownerUserId, entityId: entity.id, alias: alias.alias, aliasNormalized: normalizeKnowledgeName(alias.alias), locale: alias.locale, createdAt: now, updatedAt: now })

      const mergeCandidates: KnowledgeEntityMergeCandidate[] = []
      const canonicalTargets = new Set<number>()
      for (const matchedEntityId of matchedEntityIds) {
        const resolved = await this.resolveWith(repository, matchedEntityId)
        if (resolved.status !== 'ok' || resolved.value.id === entity.id || canonicalTargets.has(resolved.value.id)) continue
        canonicalTargets.add(resolved.value.id)
        mergeCandidates.push(await repository.insertMergeCandidate({
          ownerUserId: this.ownerUserId,
          sourceEntityId: entity.id,
          targetEntityId: resolved.value.id,
          matchMethod: 'normalized_name',
          matchDetail: { normalizedName },
          status: 'pending',
          decisionNote: null,
          decidedAt: null,
          createdAt: now,
          updatedAt: now,
        }))
      }
      return ok({ entity, mergeCandidates })
    })
  }

  async addExternalId(input: { entityId: number; idType: string; idValue: string }): Promise<KnowledgeResult<KnowledgeEntityExternalId>> {
    const idType = input.idType.trim()
    const idValue = input.idValue.trim()
    if (!bounded(idType, 64) || !bounded(idValue, 255)) return rejected('INVALID_INPUT', 'External identifier type and value are required and bounded.')
    return this.repository.transaction(async repository => {
      const entityResult = await this.resolveWith(repository, input.entityId)
      if (entityResult.status !== 'ok') return entityResult
      const existing = (await repository.listEntityExternalIds(this.ownerUserId)).find(item => item.idType === idType && item.idValue === idValue)
      if (existing) {
        const existingEntity = await this.resolveWith(repository, existing.entityId)
        if (existingEntity.status !== 'ok') return existingEntity
        if (existingEntity.value.id === entityResult.value.id) return ok(existing)
        const now = this.timestamp()
        await repository.insertMergeCandidate({ ownerUserId: this.ownerUserId, sourceEntityId: entityResult.value.id, targetEntityId: existingEntity.value.id, matchMethod: 'exact_external_id', matchDetail: { idType, idValue }, status: 'pending', decisionNote: null, decidedAt: null, createdAt: now, updatedAt: now })
        return rejected('DUPLICATE_ENTITY', 'External identifier belongs to a different entity and requires owner review.', { existingEntityId: existingEntity.value.id, matchedOn: { method: 'exact_external_id', idType, idValue } })
      }
      const now = this.timestamp()
      return ok(await repository.insertEntityExternalId({ ownerUserId: this.ownerUserId, entityId: entityResult.value.id, idType, idValue, createdAt: now, updatedAt: now }))
    })
  }

  async addAlias(input: { entityId: number; alias: string; locale?: string }): Promise<KnowledgeResult<KnowledgeEntityAlias>> {
    const alias = input.alias.trim()
    const aliasNormalized = normalizeKnowledgeName(alias)
    if (!bounded(alias, 255) || !aliasNormalized) return rejected('INVALID_INPUT', 'Alias must be a bounded non-empty string.')
    return this.repository.transaction(async repository => {
      const entityResult = await this.resolveWith(repository, input.entityId)
      if (entityResult.status !== 'ok') return entityResult
      const aliases = await repository.listEntityAliases(this.ownerUserId)
      const sameEntity = aliases.find(item => item.entityId === entityResult.value.id && item.aliasNormalized === aliasNormalized)
      if (sameEntity) return ok(sameEntity)
      const now = this.timestamp()
      const saved = await repository.insertEntityAlias({ ownerUserId: this.ownerUserId, entityId: entityResult.value.id, alias, aliasNormalized, locale: input.locale?.trim() || null, createdAt: now, updatedAt: now })
      const targetIds = new Set<number>()
      for (const entity of await repository.listEntities(this.ownerUserId)) if (entity.id !== entityResult.value.id && normalizeKnowledgeName(entity.canonicalName) === aliasNormalized) targetIds.add(entity.id)
      for (const existing of aliases) if (existing.entityId !== entityResult.value.id && existing.aliasNormalized === aliasNormalized) targetIds.add(existing.entityId)
      for (const targetId of targetIds) {
        const target = await this.resolveWith(repository, targetId)
        if (target.status === 'ok' && target.value.id !== entityResult.value.id) await repository.insertMergeCandidate({ ownerUserId: this.ownerUserId, sourceEntityId: entityResult.value.id, targetEntityId: target.value.id, matchMethod: 'normalized_name', matchDetail: { normalizedName: aliasNormalized }, status: 'pending', decisionNote: null, decidedAt: null, createdAt: now, updatedAt: now })
      }
      return ok(saved)
    })
  }

  async mergeEntities(input: { sourceEntityId: number; targetEntityId: number; reason: string; candidateId?: number }): Promise<KnowledgeResult<KnowledgeEntityMergeEvent>> {
    const reason = input.reason.trim()
    if (input.sourceEntityId === input.targetEntityId || !bounded(reason, 500)) return rejected('INVALID_INPUT', 'Merge requires distinct entities and a bounded reason.')
    return this.repository.transaction(async repository => {
      const source = await repository.getEntity(this.ownerUserId, input.sourceEntityId)
      const target = await repository.getEntity(this.ownerUserId, input.targetEntityId)
      if (!source || !target) return rejected('ENTITY_NOT_FOUND', 'Both merge entities must belong to this owner.')
      if (source.status !== 'active' || target.status !== 'active') return rejected('MERGE_NOT_ACTIVE', 'Both source and target entities must be active.')
      const resolvedTarget = await this.resolveWith(repository, target.id)
      if (resolvedTarget.status !== 'ok') return resolvedTarget
      if (resolvedTarget.value.id === source.id) return rejected('MERGE_CYCLE', 'Merge target resolves back to the source entity.')
      let candidate: KnowledgeEntityMergeCandidate | null = null
      if (input.candidateId !== undefined) {
        candidate = await repository.getMergeCandidate(this.ownerUserId, input.candidateId)
        if (!candidate) return rejected('MERGE_CANDIDATE_NOT_FOUND', 'Merge candidate does not exist for this owner.')
        if (candidate.status !== 'pending' || candidate.sourceEntityId !== source.id || candidate.targetEntityId !== target.id) return rejected('INVALID_INPUT', 'Merge candidate is not the pending pair being merged.')
      }
      const now = this.timestamp()
      await repository.updateEntity(this.ownerUserId, source.id, { status: 'merged', mergedIntoEntityId: target.id, updatedAt: now })
      const event = await repository.insertMergeEvent({ ownerUserId: this.ownerUserId, sourceEntityId: source.id, targetEntityId: target.id, candidateId: candidate?.id ?? null, reason, undoneAt: null, undoReason: null, createdAt: now, updatedAt: now })
      if (candidate) await repository.updateMergeCandidate(this.ownerUserId, candidate.id, { status: 'approved', decisionNote: reason, decidedAt: now, updatedAt: now })
      return ok(event)
    })
  }

  async undoMerge(input: { mergeEventId: number; reason: string }): Promise<KnowledgeResult<KnowledgeEntityMergeEvent>> {
    const reason = input.reason.trim()
    if (!bounded(reason, 500)) return rejected('INVALID_INPUT', 'Undo reason is required and bounded.')
    return this.repository.transaction(async repository => {
      const event = await repository.getMergeEvent(this.ownerUserId, input.mergeEventId)
      if (!event) return rejected('UNDO_NOT_LATEST', 'Merge event does not exist for this owner.')
      const activeEvents = (await repository.listMergeEvents(this.ownerUserId, event.sourceEntityId)).filter(item => item.undoneAt === null).sort((left, right) => right.id - left.id)
      if (event.undoneAt !== null || activeEvents[0]?.id !== event.id) return rejected('UNDO_NOT_LATEST', 'Only the latest non-undone event for this source can be undone.')
      const source = await repository.getEntity(this.ownerUserId, event.sourceEntityId)
      if (!source || source.status !== 'merged' || source.mergedIntoEntityId !== event.targetEntityId) return rejected('UNDO_NOT_LATEST', 'Source entity no longer projects this merge event.')
      const now = this.timestamp()
      await repository.updateEntity(this.ownerUserId, source.id, { status: 'active', mergedIntoEntityId: null, updatedAt: now })
      const updated = await repository.updateMergeEvent(this.ownerUserId, event.id, { undoneAt: now, undoReason: reason, updatedAt: now })
      return updated ? ok(updated) : rejected('UNDO_NOT_LATEST', 'Merge event could not be marked undone.')
    })
  }

  private async transitionWith(repository: KnowledgeRepository, claim: KnowledgeClaim, toStatus: KnowledgeClaimStatus, reason: string, triggeredBy: 'system' | 'owner'): Promise<KnowledgeClaim> {
    if (claim.status === toStatus) return claim
    const now = this.timestamp()
    const updated = await repository.updateClaim(this.ownerUserId, claim.id, { status: toStatus, updatedAt: now })
    if (!updated) throw new Error('Claim disappeared during an owner-scoped transaction.')
    await repository.insertClaimStatusEvent({ ownerUserId: this.ownerUserId, claimId: claim.id, fromStatus: claim.status, toStatus, reason, triggeredBy, createdAt: now, updatedAt: now })
    return updated
  }

  async createClaim(input: CreateKnowledgeClaimInput): Promise<KnowledgeResult<KnowledgeClaim>> {
    const statement = input.statement.trim()
    const entityIds = [...new Set(input.entityIds)]
    if (!statement || entityIds.length < 1 || (input.validFrom && input.validTo && input.validFrom > input.validTo)) return rejected('INVALID_INPUT', 'Claim statement, linked entities, and validity range are invalid.')
    return this.repository.transaction(async repository => {
      const canonicalEntityIds: number[] = []
      for (const entityId of entityIds) {
        const entity = await this.resolveWith(repository, entityId)
        if (entity.status !== 'ok') return entity
        canonicalEntityIds.push(entity.value.id)
      }
      const now = this.timestamp()
      const claim = await repository.insertClaim({ ownerUserId: this.ownerUserId, statement, claimType: input.claimType, status: 'unverified', validFrom: input.validFrom ?? null, validTo: input.validTo ?? null, createdAt: now, updatedAt: now })
      for (const entityId of new Set(canonicalEntityIds)) await repository.insertClaimEntityLink({ ownerUserId: this.ownerUserId, claimId: claim.id, entityId, createdAt: now, updatedAt: now })
      return ok(claim)
    })
  }

  async transitionClaim(input: { claimId: number; toStatus: KnowledgeClaimStatus; reason: string }): Promise<KnowledgeResult<KnowledgeClaim>> {
    const reason = input.reason.trim()
    if (!bounded(reason, 500)) return rejected('INVALID_INPUT', 'Manual claim transition reason is required and bounded.')
    return this.repository.transaction(async repository => {
      const claim = await repository.getClaim(this.ownerUserId, input.claimId)
      if (!claim) return rejected('CLAIM_NOT_FOUND', 'Claim does not exist for this owner.')
      const allowed = (claim.status === 'source_backed' && input.toStatus === 'independently_confirmed')
        || (['unverified', 'source_backed'].includes(claim.status) && input.toStatus === 'first_party_measured')
        || (['source_backed', 'independently_confirmed', 'first_party_measured'].includes(claim.status) && input.toStatus === 'expired')
        || (claim.status === 'expired' && input.toStatus === 'unverified')
        || (claim.status !== 'retracted' && input.toStatus === 'retracted')
      if (!allowed) return rejected('INVALID_TRANSITION', `Claim cannot transition from ${claim.status} to ${input.toStatus}.`)
      return ok(await this.transitionWith(repository, claim, input.toStatus, reason, 'owner'))
    })
  }

  private async ensureDisputed(repository: KnowledgeRepository, claim: KnowledgeClaim, reason: string): Promise<KnowledgeClaim> {
    if (claim.status === 'disputed' || claim.status === 'retracted') return claim
    if (!DISPUTABLE_STATUSES.includes(claim.status)) return claim
    return this.transitionWith(repository, claim, 'disputed', reason, 'system')
  }

  private async openDispute(repository: KnowledgeRepository, claimA: KnowledgeClaim, claimB: KnowledgeClaim, method: KnowledgeClaimDispute['detectionMethod'], reason: string): Promise<KnowledgeResult<KnowledgeClaimDispute>> {
    const [claimAId, claimBId] = claimA.id < claimB.id ? [claimA.id, claimB.id] : [claimB.id, claimA.id]
    if (claimAId === claimBId) return rejected('INVALID_INPUT', 'A claim cannot dispute itself.')
    const existing = (await repository.listDisputes(this.ownerUserId, 'open')).find(item => item.claimAId === claimAId && item.claimBId === claimBId)
    if (existing) return rejected('DISPUTE_ALREADY_OPEN', 'This normalized claim pair already has an open dispute.')
    if (![...DISPUTABLE_STATUSES, 'disputed'].includes(claimA.status) || ![...DISPUTABLE_STATUSES, 'disputed'].includes(claimB.status)) return rejected('INVALID_TRANSITION', 'Only active, non-expired, non-retracted claims can enter a dispute.')
    const now = this.timestamp()
    const dispute = await repository.insertDispute({ ownerUserId: this.ownerUserId, claimAId, claimBId, detectionMethod: method, detectionReason: reason, status: 'open', resolution: null, resolutionNote: null, resolvedAt: null, createdAt: now, updatedAt: now })
    await this.ensureDisputed(repository, claimA, reason)
    await this.ensureDisputed(repository, claimB, reason)
    return ok(dispute)
  }

  async addEvidence(input: { claimId: number; sourceVersionId: number; relation: KnowledgeEvidenceRelation; locator: string; contentHash: string; reviewNotes?: string }): Promise<KnowledgeResult<{ evidence: import('./types').KnowledgeClaimEvidence; disputes: KnowledgeClaimDispute[] }>> {
    const locator = input.locator.trim()
    if (!bounded(locator, 500) || !validHash(input.contentHash)) return rejected('INVALID_INPUT', 'Evidence locator and lowercase SHA-256 content hash are required.')
    return this.repository.transaction(async repository => {
      let claim = await repository.getClaim(this.ownerUserId, input.claimId)
      if (!claim) return rejected('CLAIM_NOT_FOUND', 'Claim does not exist for this owner.')
      if (!await repository.getSourceVersion(this.ownerUserId, input.sourceVersionId)) return rejected('SOURCE_VERSION_NOT_FOUND', 'Source version does not exist for this owner.')
      const locatorHash = sha256(locator)
      const duplicate = (await repository.listClaimEvidence(this.ownerUserId, claim.id)).find(item => item.sourceVersionId === input.sourceVersionId && item.relation === input.relation && item.locatorHash === locatorHash)
      if (duplicate) return rejected('DUPLICATE_EVIDENCE', 'This exact version-bound evidence relationship already exists.')
      const now = this.timestamp()
      const evidence = await repository.insertClaimEvidence({ ownerUserId: this.ownerUserId, claimId: claim.id, sourceVersionId: input.sourceVersionId, relation: input.relation, locator, locatorHash, contentHash: input.contentHash, reviewNotes: input.reviewNotes?.trim() || null, createdAt: now, updatedAt: now })
      if (input.relation === 'supports' && claim.status === 'unverified') claim = await this.transitionWith(repository, claim, 'source_backed', `Supporting evidence ${evidence.id} was added.`, 'system')
      if (input.relation === 'contradicts' && DISPUTABLE_STATUSES.includes(claim.status)) claim = await this.transitionWith(repository, claim, 'disputed', `Contradicting evidence ${evidence.id} was added.`, 'system')

      const opened: KnowledgeClaimDispute[] = []
      if (input.relation === 'contradicts' && claim.status === 'disputed') {
        const links = await repository.listClaimEntityLinks(this.ownerUserId)
        const entityIds = new Set(links.filter(item => item.claimId === claim.id).map(item => item.entityId))
        const otherIds = new Set(links.filter(item => item.claimId !== claim.id && entityIds.has(item.entityId)).map(item => item.claimId))
        const allEvidence = await repository.listClaimEvidence(this.ownerUserId)
        for (const otherId of otherIds) {
          if (!allEvidence.some(item => item.claimId === otherId && item.sourceVersionId === input.sourceVersionId && item.relation === 'supports')) continue
          const other = await repository.getClaim(this.ownerUserId, otherId)
          if (!other || other.status === 'retracted') continue
          const result = await this.openDispute(repository, claim, other, 'shared_source_conflict', `Source version ${input.sourceVersionId} contradicts claim ${claim.id} while supporting claim ${other.id}.`)
          if (result.status === 'ok') opened.push(result.value)
          else if (result.code !== 'DISPUTE_ALREADY_OPEN') return result
        }
      }
      return ok({ evidence, disputes: opened })
    })
  }

  async createManualDispute(input: { claimAId: number; claimBId: number; reason: string }): Promise<KnowledgeResult<KnowledgeClaimDispute>> {
    const reason = input.reason.trim()
    if (!bounded(reason, 500)) return rejected('INVALID_INPUT', 'Manual dispute reason is required and bounded.')
    return this.repository.transaction(async repository => {
      const claimA = await repository.getClaim(this.ownerUserId, input.claimAId)
      const claimB = await repository.getClaim(this.ownerUserId, input.claimBId)
      if (!claimA || !claimB) return rejected('CLAIM_NOT_FOUND', 'Both claims must belong to this owner.')
      return this.openDispute(repository, claimA, claimB, 'manual', reason)
    })
  }

  async resolveDispute(input: { disputeId: number; resolution: 'kept_a' | 'kept_b' | 'both_stand' | 'other'; resolutionNote: string; retractClaimId?: number }): Promise<KnowledgeResult<KnowledgeClaimDispute>> {
    const resolutionNote = input.resolutionNote.trim()
    if (!bounded(resolutionNote, 500)) return rejected('INVALID_INPUT', 'Dispute resolution note is required and bounded.')
    return this.repository.transaction(async repository => {
      const dispute = await repository.getDispute(this.ownerUserId, input.disputeId)
      if (!dispute) return rejected('DISPUTE_NOT_FOUND', 'Dispute does not exist for this owner.')
      if (dispute.status !== 'open') return rejected('INVALID_TRANSITION', 'Only an open dispute can be resolved.')
      if (input.retractClaimId !== undefined && ![dispute.claimAId, dispute.claimBId].includes(input.retractClaimId)) return rejected('INVALID_INPUT', 'retractClaimId must identify one claim in this dispute.')
      const now = this.timestamp()
      const updated = await repository.updateDispute(this.ownerUserId, dispute.id, { status: 'resolved', resolution: input.resolution, resolutionNote, resolvedAt: now, updatedAt: now })
      if (!updated) return rejected('DISPUTE_NOT_FOUND', 'Dispute disappeared during resolution.')
      for (const claimId of [dispute.claimAId, dispute.claimBId]) {
        let claim = await repository.getClaim(this.ownerUserId, claimId)
        if (!claim || claim.status === 'retracted') continue
        if (input.retractClaimId === claimId) {
          await this.transitionWith(repository, claim, 'retracted', resolutionNote, 'owner')
          continue
        }
        if (claim.status !== 'disputed') continue
        const stillOpen = (await repository.listDisputes(this.ownerUserId, 'open')).some(item => item.claimAId === claimId || item.claimBId === claimId)
        if (stillOpen) continue
        const evidence = await repository.listClaimEvidence(this.ownerUserId, claimId)
        claim = await this.transitionWith(repository, claim, evidence.some(item => item.relation === 'supports') ? 'source_backed' : 'unverified', `Dispute ${dispute.id} was resolved; status recomputed from retained evidence.`, 'system')
      }
      return ok(updated)
    })
  }

  async registerSource(input: { canonicalUrl: string; title?: string; sourceClass: KnowledgeSourceClass; notes?: string }): Promise<KnowledgeResult<import('./types').KnowledgeSource>> {
    const canonicalUrl = normalizeKnowledgeUrl(input.canonicalUrl)
    if (!canonicalUrl || canonicalUrl.length > 500) return rejected('INVALID_INPUT', 'Source canonicalUrl must be a bounded HTTP(S) URL.')
    return this.repository.transaction(async repository => {
      const urlHash = sha256(canonicalUrl)
      if ((await repository.listSources(this.ownerUserId)).some(item => item.urlHash === urlHash)) return rejected('DUPLICATE_SOURCE', 'This normalized source URL is already registered.')
      const now = this.timestamp()
      return ok(await repository.insertSource({ ownerUserId: this.ownerUserId, canonicalUrl, urlHash, title: input.title?.trim() || null, sourceClass: input.sourceClass, status: 'active', notes: input.notes?.trim() || null, createdAt: now, updatedAt: now }))
    })
  }

  async addSourceVersion(input: { sourceId: number; contentHash: string; retrievedAt: Date; excerpt?: string; metadata?: unknown }): Promise<KnowledgeResult<import('./types').KnowledgeSourceVersion>> {
    if (!validHash(input.contentHash) || !Number.isFinite(input.retrievedAt.getTime()) || (input.excerpt !== undefined && input.excerpt.length > 5_000)) return rejected('INVALID_INPUT', 'Source version requires a lowercase SHA-256 hash, valid retrieval time, and bounded excerpt.')
    return this.repository.transaction(async repository => {
      if (!await repository.getSource(this.ownerUserId, input.sourceId)) return rejected('SOURCE_NOT_FOUND', 'Source does not exist for this owner.')
      const versions = await repository.listSourceVersions(this.ownerUserId, input.sourceId)
      const versionNumber = versions.reduce((maximum, item) => Math.max(maximum, item.versionNumber), 0) + 1
      const now = this.timestamp()
      return ok(await repository.insertSourceVersion({ ownerUserId: this.ownerUserId, sourceId: input.sourceId, versionNumber, contentHash: input.contentHash, retrievedAt: new Date(input.retrievedAt), excerpt: input.excerpt?.trim() || null, metadata: input.metadata ?? null, createdAt: now, updatedAt: now }))
    })
  }

  async setPublisherEntity(input: { organizationEntityId: number }): Promise<KnowledgeResult<KnowledgeEntity>> {
    return this.repository.transaction(async repository => {
      const entity = await this.resolveWith(repository, input.organizationEntityId)
      if (entity.status !== 'ok') return entity
      if (entity.value.status !== 'active' || !ORGANIZATION_ENTITY_TYPES.has(entity.value.entityType)) return rejected('PUBLISHER_ENTITY_INVALID', 'Publisher must resolve to an active Organization or Brand entity.')
      const now = this.timestamp()
      await repository.upsertPublisherSetting({ ownerUserId: this.ownerUserId, organizationEntityId: entity.value.id, createdAt: now, updatedAt: now })
      return ok(entity.value)
    })
  }

  async getPublisherEntity(): Promise<KnowledgeEntity | null> {
    const setting = await this.repository.getPublisherSetting(this.ownerUserId)
    if (!setting) return null
    const resolved = await this.resolveWith(this.repository, setting.organizationEntityId)
    return resolved.status === 'ok' && resolved.value.status === 'active' ? resolved.value : null
  }

  async linkContentEntity(input: { briefId: number; entityId: number; role: KnowledgeContentEntityRole }): Promise<KnowledgeResult<KnowledgeContentEntityLink>> {
    return this.repository.transaction(async repository => {
      if (!await repository.getContentAnchor({ ownerUserId: this.ownerUserId, briefId: input.briefId })) return rejected('CONTENT_ANCHOR_NOT_FOUND', 'Brief has no owner-scoped draft anchor.')
      const entity = await this.resolveWith(repository, input.entityId)
      if (entity.status !== 'ok') return entity
      const duplicate = (await repository.listContentEntityLinks(this.ownerUserId, input.briefId)).find(item => item.entityId === entity.value.id && item.role === input.role)
      if (duplicate) return rejected('CONTENT_LINK_DUPLICATE', 'This canonical entity role is already linked to the brief.')
      const now = this.timestamp()
      return ok(await repository.insertContentEntityLink({ ownerUserId: this.ownerUserId, briefId: input.briefId, entityId: entity.value.id, role: input.role, createdAt: now, updatedAt: now }))
    })
  }

  async unlinkContentEntity(input: { briefId: number; entityId: number; role: KnowledgeContentEntityRole }): Promise<KnowledgeResult<true>> {
    const requested = await this.resolveWith(this.repository, input.entityId)
    if (requested.status !== 'ok') return requested
    const links = await this.repository.listContentEntityLinks(this.ownerUserId, input.briefId)
    for (const link of links) {
      if (link.role !== input.role) continue
      const linked = await this.resolveWith(this.repository, link.entityId)
      if (linked.status !== 'ok' || linked.value.id !== requested.value.id) continue
      if (await this.repository.deleteContentEntityLink(this.ownerUserId, input.briefId, link.entityId, input.role)) return ok(true)
    }
    return rejected('CONTENT_LINK_NOT_FOUND', 'Content entity link does not exist for this owner.')
  }

  async listContentEntityLinks(input: { briefId: number }): Promise<KnowledgeContentEntityLink[]> {
    const links = await this.repository.listContentEntityLinks(this.ownerUserId, input.briefId)
    const projected: KnowledgeContentEntityLink[] = []
    for (const link of links) {
      const entity = await this.resolveWith(this.repository, link.entityId)
      if (entity.status === 'ok') projected.push({ ...link, entityId: entity.value.id })
    }
    return projected
  }

  async listContentKnowledgeGaps(): Promise<KnowledgeContentGap[]> {
    const anchors = await this.repository.listContentAnchors(this.ownerUserId)
    const briefIds = [...new Set(anchors.map(item => item.briefId))].sort((left, right) => left - right)
    const links = await this.repository.listContentEntityLinks(this.ownerUserId)
    const gaps: KnowledgeContentGap[] = briefIds.filter(briefId => !links.some(item => item.briefId === briefId && item.role === 'author')).map(briefId => ({ type: 'missing_author', briefId }))
    if (!await this.getPublisherEntity()) gaps.push({ type: 'missing_publisher' })
    return gaps
  }

  async listClaims(input: { status?: KnowledgeClaimStatus } = {}) { return this.repository.listClaims(this.ownerUserId, input.status) }
  async listDisputes(input: { status?: KnowledgeClaimDispute['status'] } = {}) { return this.repository.listDisputes(this.ownerUserId, input.status) }
  async listClaimStatusEvents(input: { claimId?: number } = {}) { return this.repository.listClaimStatusEvents(this.ownerUserId, input.claimId) }
  async listMergeCandidates(input: { status?: KnowledgeEntityMergeCandidate['status'] } = {}) { return this.repository.listMergeCandidates(this.ownerUserId, input.status) }
  async listMergeEvents(input: { sourceEntityId?: number } = {}) { return this.repository.listMergeEvents(this.ownerUserId, input.sourceEntityId) }
}

export function createKnowledgeService(options: KnowledgeServiceOptions): KnowledgeService {
  return new KnowledgeService(options)
}
