import { DrizzleKnowledgeRepository } from './repository-drizzle'
import { assertKnowledgeRevisionSubject, assertValidKnowledgeMutationEvent, assertValidKnowledgeRevision, knowledgeRevisionCanonicalJson, knowledgeRevisionSha256 } from './revision-records'
import { KNOWLEDGE_REVISION_SCHEMA, KnowledgeRevisionError, type KnowledgeRevision, type KnowledgeRevisionHistory, type KnowledgeRevisionHistoryItem, type KnowledgeRevisionSubject } from './revision-types'
import type { KnowledgeRepository } from './types'

const PAGE_SIZE = 25
const CURSOR_SCHEMA = 'knowledge-revision-history-cursor-v1'
interface HistoryCursor { schemaVersion: typeof CURSOR_SCHEMA; ownerUserId: number; kind: KnowledgeRevisionSubject['kind']; id: number; beforeId: number; expectedRevisionNumber: number; expectedRevisionFingerprint: string }
function fail(code: ConstructorParameters<typeof KnowledgeRevisionError>[0]): never { throw new KnowledgeRevisionError(code) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(',') }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }

function encodeCursor(ownerUserId: number, subject: KnowledgeRevisionSubject, last: KnowledgeRevision): string {
  if (last.revisionNumber <= 1 || !last.previousRevisionFingerprint) return fail('CORRUPT_STATE')
  const payload: HistoryCursor = { schemaVersion: CURSOR_SCHEMA, ownerUserId, kind: subject.kind, id: subject.id, beforeId: last.id, expectedRevisionNumber: last.revisionNumber - 1, expectedRevisionFingerprint: last.previousRevisionFingerprint }
  const canonical = knowledgeRevisionCanonicalJson(payload)
  // A checksum catches damaged cursors. It is not authentication; every read still uses server owner scope.
  return Buffer.from(knowledgeRevisionCanonicalJson({ payload, checksum: knowledgeRevisionSha256(canonical) }), 'utf8').toString('base64url')
}
function decodeCursor(value: string, ownerUserId: number, subject: KnowledgeRevisionSubject): HistoryCursor {
  if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) return fail('INVALID_INPUT')
  let decoded: unknown
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) return fail('INVALID_INPUT')
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch { return fail('INVALID_INPUT') }
  if (!record(decoded) || !exactKeys(decoded, ['payload', 'checksum']) || !record(decoded.payload) || !hash(decoded.checksum)) return fail('INVALID_INPUT')
  const payload = decoded.payload
  if (!exactKeys(payload, ['schemaVersion', 'ownerUserId', 'kind', 'id', 'beforeId', 'expectedRevisionNumber', 'expectedRevisionFingerprint']) || payload.schemaVersion !== CURSOR_SCHEMA || payload.ownerUserId !== ownerUserId || payload.kind !== subject.kind || payload.id !== subject.id || !integer(payload.beforeId) || !integer(payload.expectedRevisionNumber) || !hash(payload.expectedRevisionFingerprint) || knowledgeRevisionSha256(knowledgeRevisionCanonicalJson(payload)) !== decoded.checksum) return fail('INVALID_INPUT')
  return payload as unknown as HistoryCursor
}

function parseInput(ownerUserId: number, input: unknown): { subject: KnowledgeRevisionSubject; cursor: HistoryCursor | undefined } {
  if (!record(input) || Object.keys(input).some(key => !['kind', 'id', 'cursor'].includes(key)) || typeof input.kind !== 'string' || !['entity', 'claim', 'source'].includes(input.kind) || typeof input.id !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(input.id) || (input.cursor !== undefined && typeof input.cursor !== 'string')) return fail('INVALID_INPUT')
  const subject: KnowledgeRevisionSubject = { kind: input.kind as KnowledgeRevisionSubject['kind'], id: Number(input.id) }
  assertKnowledgeRevisionSubject(ownerUserId, subject)
  if (!integer(subject.id)) return fail('INVALID_INPUT')
  return { subject, cursor: input.cursor === undefined ? undefined : decodeCursor(input.cursor as string, ownerUserId, subject) }
}

export async function getKnowledgeRevisionHistory(ownerUserId: number, input: unknown, repository?: KnowledgeRepository): Promise<KnowledgeRevisionHistory> {
  const { subject, cursor } = parseInput(ownerUserId, input)
  const storage = repository ?? new DrizzleKnowledgeRepository()
  return storage.transaction(async transaction => {
    const found = subject.kind === 'entity' ? await transaction.getEntity(ownerUserId, subject.id) : subject.kind === 'claim' ? await transaction.getClaim(ownerUserId, subject.id) : await transaction.getSource(ownerUserId, subject.id)
    if (!found || found.ownerUserId !== ownerUserId || found.id !== subject.id) return fail('SUBJECT_NOT_FOUND')
    const rows = await transaction.listRevisions(ownerUserId, subject, cursor?.beforeId, PAGE_SIZE + 1)
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE + 1) return fail('LIMIT_EXCEEDED')
    if (cursor && (!rows[0] || rows[0].revisionNumber !== cursor.expectedRevisionNumber || rows[0].revisionFingerprint !== cursor.expectedRevisionFingerprint)) return fail('REVISION_CONFLICT')
    const items: KnowledgeRevisionHistoryItem[] = []
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!
      assertValidKnowledgeRevision(row)
      if (!integer(row.id) || row.schemaVersion !== KNOWLEDGE_REVISION_SCHEMA || row.ownerUserId !== ownerUserId || row.subjectKind !== subject.kind || row.subjectId !== subject.id || (cursor && row.id >= cursor.beforeId)) return fail('CORRUPT_STATE')
      const previous = rows[index - 1]
      if (previous && (previous.id <= row.id || previous.revisionNumber !== row.revisionNumber + 1 || previous.previousRevisionFingerprint !== row.revisionFingerprint)) return fail('CORRUPT_STATE')
      const event = await transaction.getMutationEventForRevision(ownerUserId, row.revisionFingerprint)
      if (!event) return fail('CORRUPT_STATE')
      assertValidKnowledgeMutationEvent(event)
      if (!integer(event.id) || event.ownerUserId !== ownerUserId || event.subjectKind !== subject.kind || event.subjectId !== subject.id || event.revisionId !== row.id || event.revisionNumber !== row.revisionNumber || event.previousRevisionFingerprint !== row.previousRevisionFingerprint || event.newRevisionFingerprint !== row.revisionFingerprint || event.operations.join(',') !== row.operations.join(',')) return fail('CORRUPT_STATE')
      if (index < PAGE_SIZE) items.push({ revisionId: row.id, revisionNumber: row.revisionNumber, revisionKind: row.revisionKind, contentHash: row.contentHash, previousRevisionFingerprint: row.previousRevisionFingerprint, revisionFingerprint: row.revisionFingerprint, eventFingerprint: event.eventFingerprint, operations: [...row.operations], occurredAt: row.createdAt.toISOString() })
    }
    const last = rows[Math.min(rows.length, PAGE_SIZE) - 1]
    if (rows.length > 0 && rows.length <= PAGE_SIZE && last?.revisionNumber !== 1) return fail('CORRUPT_STATE')
    return { subject, items, nextCursor: rows.length > PAGE_SIZE ? encodeCursor(ownerUserId, subject, last!) : null, historyScope: 'recorded_mutations_only', rawSnapshotIncluded: false, automaticPublication: false, productionActivation: false, automaticTrainingAdmission: false }
  }, { consistentReadOnly: true })
}
