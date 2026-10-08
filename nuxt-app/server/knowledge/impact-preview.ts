import { DrizzleKnowledgeRepository } from './repository-drizzle'
import {
  KNOWLEDGE_IMPACT_MAX_ROWS_PER_COLLECTION,
  KnowledgeImpactError,
  type KnowledgeImpactReport,
  type KnowledgeImpactSnapshot,
  type KnowledgeImpactSubject,
  type KnowledgeImpactSubjectKind,
} from './impact-types'
import { createNativeKnowledgeImpactCoverage, resolveKnowledgeImpact } from './impact-resolver'
import type { KnowledgeRepository } from './types'
import { KnowledgeRevisionError } from './revision-types'
import { KnowledgeConsumerBindingError } from './consumer-binding-types'

const SENTINEL_LIMIT = KNOWLEDGE_IMPACT_MAX_ROWS_PER_COLLECTION + 1

export function parseKnowledgeImpactSubject(value: unknown): KnowledgeImpactSubject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KnowledgeImpactError('INVALID_INPUT', 'A single impact subject is required.')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'kind') || !Object.hasOwn(record, 'id')) {
    throw new KnowledgeImpactError('INVALID_INPUT', 'Impact subject accepts only kind and id.')
  }
  const kinds: readonly string[] = ['entity', 'claim', 'source']
  if (typeof record.kind !== 'string' || !kinds.includes(record.kind)) throw new KnowledgeImpactError('INVALID_INPUT', 'Impact subject kind is invalid.')
  const id = typeof record.id === 'number'
    ? record.id
    : typeof record.id === 'string' && /^[1-9]\d*$/u.test(record.id) && record.id.length <= 16
      ? Number(record.id)
      : Number.NaN
  if (!Number.isSafeInteger(id) || id <= 0) throw new KnowledgeImpactError('INVALID_INPUT', 'Impact subject id must be a positive integer.')
  return { kind: record.kind as KnowledgeImpactSubjectKind, id }
}

async function readSnapshot(repository: KnowledgeRepository, ownerUserId: number): Promise<KnowledgeImpactSnapshot> {
  return repository.transaction(async tx => {
    const [entities, aliases, externalIds, sources, sourceVersions, claims, claimEntityLinks, evidence, contentLinks, publisher, anchors, revisionHeads, adapterCoverage] = await Promise.all([
      tx.listEntities(ownerUserId, SENTINEL_LIMIT),
      tx.listEntityAliases(ownerUserId, undefined, SENTINEL_LIMIT),
      tx.listEntityExternalIds(ownerUserId, undefined, SENTINEL_LIMIT),
      tx.listSources(ownerUserId, SENTINEL_LIMIT),
      tx.listSourceVersions(ownerUserId, undefined, SENTINEL_LIMIT),
      tx.listClaims(ownerUserId, undefined, SENTINEL_LIMIT),
      tx.listClaimEntityLinks(ownerUserId, undefined, SENTINEL_LIMIT),
      tx.listClaimEvidence(ownerUserId, undefined, SENTINEL_LIMIT),
      tx.listContentEntityLinks(ownerUserId, undefined, SENTINEL_LIMIT),
      tx.getPublisherSetting(ownerUserId),
      tx.listContentAnchors(ownerUserId, SENTINEL_LIMIT),
      tx.listRevisionHeads(ownerUserId, SENTINEL_LIMIT),
      tx.listConsumerCoverage ? tx.listConsumerCoverage(ownerUserId) : Promise.resolve(createNativeKnowledgeImpactCoverage()),
    ])
    const bounded = [entities, aliases, externalIds, sources, sourceVersions, claims, claimEntityLinks, evidence, contentLinks, anchors, revisionHeads]
    if (bounded.some(rows => rows.length > KNOWLEDGE_IMPACT_MAX_ROWS_PER_COLLECTION)) {
      throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Knowledge impact snapshot exceeds the bounded limit.')
    }
    return {
      entities, aliases, externalIds, sources, sourceVersions, claims, claimEntityLinks, evidence, contentLinks, publisher,
      // The anchor query is owner-scoped; derive its authority from the authenticated owner, not request input.
      contentAnchors: anchors.map(anchor => ({ ...anchor, ownerUserId })),
      adapterCoverage,
      revisionHeads,
    }
  }, { consistentReadOnly: true })
}

export { resolveKnowledgeImpact }

export async function createKnowledgeImpactPreview(ownerUserId: number, subject: KnowledgeImpactSubject, repository?: KnowledgeRepository): Promise<KnowledgeImpactReport> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) throw new KnowledgeImpactError('INVALID_INPUT', 'Owner is invalid.')
  const source = repository ?? new DrizzleKnowledgeRepository()
  try {
    return resolveKnowledgeImpact(ownerUserId, subject, await readSnapshot(source, ownerUserId))
  } catch (error) {
    if (error instanceof KnowledgeRevisionError || error instanceof KnowledgeConsumerBindingError) {
      throw new KnowledgeImpactError(error.code === 'LIMIT_EXCEEDED' ? 'SNAPSHOT_LIMIT_EXCEEDED' : 'CORRUPT_GRAPH', 'Knowledge impact revision heads could not be verified.')
    }
    throw error
  }
}
