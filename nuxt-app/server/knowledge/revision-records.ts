import { createHash } from 'node:crypto'
import { KNOWLEDGE_REVISION_SCHEMA, KnowledgeRevisionError, type KnowledgeMutationEvent, type KnowledgeRevision, type KnowledgeRevisionSubject } from './revision-types'

export const KNOWLEDGE_MUTATION_OPERATIONS = [
  'deleteContentEntityLink', 'insertClaim', 'insertClaimEntityLink', 'insertClaimEvidence',
  'insertContentEntityLink', 'insertEntity', 'insertEntityAlias', 'insertEntityExternalId',
  'insertSource', 'insertSourceVersion', 'legacy_baseline', 'updateClaim', 'updateEntity', 'upsertPublisherSetting',
] as const

export function knowledgeRevisionSha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
export function knowledgeRevisionCanonicalJson(value: unknown): string {
  const active = new Set<object>()
  let count = 0
  function canonical(input: unknown, depth: number): unknown {
    if (++count > 20_000 || depth > 20) throw new KnowledgeRevisionError('LIMIT_EXCEEDED')
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (!input || typeof input !== 'object' || active.has(input) || (Object.getPrototypeOf(input) !== Object.prototype && !Array.isArray(input))) throw new KnowledgeRevisionError('CORRUPT_STATE')
    active.add(input)
    let result: unknown
    if (Array.isArray(input)) result = input.map(item => canonical(item, depth + 1))
    else {
      const object: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(input).sort()) object[key] = canonical((input as Record<string, unknown>)[key], depth + 1)
      result = object
    }
    active.delete(input)
    return result
  }
  return JSON.stringify(canonical(value, 0))
}

export function assertKnowledgeRevisionSubject(ownerUserId: number, subject: KnowledgeRevisionSubject): void {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0 || !subject || !['entity', 'claim', 'source'].includes(subject.kind) || !Number.isSafeInteger(subject.id) || subject.id <= 0) throw new KnowledgeRevisionError('INVALID_INPUT')
}
function operationsValid(values: readonly string[]): boolean {
  return Array.isArray(values) && values.length > 0 && values.length <= KNOWLEDGE_MUTATION_OPERATIONS.length && new Set(values).size === values.length && values.every(value => (KNOWLEDGE_MUTATION_OPERATIONS as readonly string[]).includes(value)) && values.join('\u0000') === [...values].sort().join('\u0000')
}
function hashValid(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function timestampValid(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }

export function knowledgeRevisionFingerprint(record: Pick<KnowledgeRevision, 'ownerUserId' | 'subjectKind' | 'subjectId' | 'schemaVersion' | 'revisionNumber' | 'revisionKind' | 'contentHash' | 'previousRevisionFingerprint' | 'operations'>): string {
  return knowledgeRevisionSha256(knowledgeRevisionCanonicalJson({ schemaVersion: record.schemaVersion, ownerUserId: record.ownerUserId, subjectKind: record.subjectKind, subjectId: record.subjectId, revisionNumber: record.revisionNumber, revisionKind: record.revisionKind, contentHash: record.contentHash, previousRevisionFingerprint: record.previousRevisionFingerprint, operations: record.operations }))
}
export function knowledgeMutationEventFingerprint(record: Pick<KnowledgeMutationEvent, 'ownerUserId' | 'subjectKind' | 'subjectId' | 'revisionNumber' | 'previousRevisionFingerprint' | 'newRevisionFingerprint' | 'operations'>): string {
  return knowledgeRevisionSha256(knowledgeRevisionCanonicalJson({ schemaVersion: 'knowledge-mutation-event-v1', ownerUserId: record.ownerUserId, subjectKind: record.subjectKind, subjectId: record.subjectId, revisionNumber: record.revisionNumber, previousRevisionFingerprint: record.previousRevisionFingerprint, newRevisionFingerprint: record.newRevisionFingerprint, operations: record.operations }))
}
export function assertValidKnowledgeRevisionMetadata(record: Omit<KnowledgeRevision, 'id' | 'canonicalSnapshot'>): void {
  assertKnowledgeRevisionSubject(record.ownerUserId, { kind: record.subjectKind, id: record.subjectId })
  if (record.schemaVersion !== KNOWLEDGE_REVISION_SCHEMA || !Number.isSafeInteger(record.revisionNumber) || record.revisionNumber <= 0 || record.revisionNumber > 2_147_483_647 || !['legacy_baseline', 'mutation'].includes(record.revisionKind) || !hashValid(record.contentHash) || !hashValid(record.revisionFingerprint) || !operationsValid(record.operations) || !timestampValid(record.createdAt) || !timestampValid(record.updatedAt)) throw new KnowledgeRevisionError('CORRUPT_STATE')
  if ((record.revisionNumber === 1) !== (record.previousRevisionFingerprint === null) || (record.previousRevisionFingerprint !== null && !hashValid(record.previousRevisionFingerprint)) || (record.revisionKind === 'legacy_baseline' && (record.revisionNumber !== 1 || record.operations.join(',') !== 'legacy_baseline')) || (record.revisionKind === 'mutation' && record.operations.includes('legacy_baseline'))) throw new KnowledgeRevisionError('CORRUPT_STATE')
  if (knowledgeRevisionFingerprint(record) !== record.revisionFingerprint) throw new KnowledgeRevisionError('CORRUPT_STATE')
}
export function assertValidKnowledgeRevision(record: Omit<KnowledgeRevision, 'id'>): void {
  assertValidKnowledgeRevisionMetadata(record)
  if (typeof record.canonicalSnapshot !== 'string' || Buffer.byteLength(record.canonicalSnapshot, 'utf8') > 65_536) throw new KnowledgeRevisionError('LIMIT_EXCEEDED')
  let snapshot: unknown
  try { snapshot = JSON.parse(record.canonicalSnapshot) } catch { throw new KnowledgeRevisionError('CORRUPT_STATE') }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || knowledgeRevisionCanonicalJson(snapshot) !== record.canonicalSnapshot || knowledgeRevisionSha256(record.canonicalSnapshot) !== record.contentHash || knowledgeRevisionFingerprint(record) !== record.revisionFingerprint) throw new KnowledgeRevisionError('CORRUPT_STATE')
  const envelope = snapshot as Record<string, unknown>
  const subject = envelope.subject
  if (envelope.schemaVersion !== KNOWLEDGE_REVISION_SCHEMA || envelope.ownerUserId !== record.ownerUserId || envelope.kind !== record.subjectKind || !subject || typeof subject !== 'object' || Array.isArray(subject) || (subject as Record<string, unknown>).id !== record.subjectId) throw new KnowledgeRevisionError('CORRUPT_STATE')
}
export function assertValidKnowledgeMutationEvent(record: Omit<KnowledgeMutationEvent, 'id'>): void {
  assertKnowledgeRevisionSubject(record.ownerUserId, { kind: record.subjectKind, id: record.subjectId })
  if (!Number.isSafeInteger(record.revisionId) || record.revisionId <= 0 || !Number.isSafeInteger(record.revisionNumber) || record.revisionNumber <= 0 || !hashValid(record.newRevisionFingerprint) || !hashValid(record.eventFingerprint) || !operationsValid(record.operations) || !timestampValid(record.createdAt) || !timestampValid(record.updatedAt) || (record.revisionNumber === 1) !== (record.previousRevisionFingerprint === null) || (record.previousRevisionFingerprint !== null && !hashValid(record.previousRevisionFingerprint)) || knowledgeMutationEventFingerprint(record) !== record.eventFingerprint) throw new KnowledgeRevisionError('CORRUPT_STATE')
}
