import { knowledgeRevisionCanonicalJson, knowledgeRevisionSha256, assertValidKnowledgeRevision, assertValidKnowledgeMutationEvent } from './revision-records'
import { buildKnowledgeRevisionSnapshot } from './revision-snapshot'
import { createNativeKnowledgeImpactCoverage } from './impact-resolver'
import { KNOWLEDGE_IMPACT_MAX_CONSUMERS_PER_CATEGORY, type KnowledgeImpactAdapterCoverage, type KnowledgeImpactConsumerRef } from './impact-types'
import { KnowledgeConsumerBindingError, type KnowledgeConsumerAnchor, type KnowledgeConsumerBinding, type KnowledgeConsumerBindingInput, type KnowledgeConsumerBindingRepository, type KnowledgeConsumerBindingHeadSummary, type KnowledgeConsumerBindingSummary } from './consumer-binding-types'

const HASH = /^[a-f0-9]{64}$/u
const INPUT_KEYS = ['consumerKind', 'consumerId', 'subjectKind', 'subjectId', 'operation', 'expectedRevisionFingerprint', 'expectedBindingFingerprint', 'idempotencyKey'] as const
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
const validHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)
const fail = (code: ConstructorParameters<typeof KnowledgeConsumerBindingError>[0]): never => { throw new KnowledgeConsumerBindingError(code) }
const fingerprint = (value: unknown) => knowledgeRevisionSha256(knowledgeRevisionCanonicalJson(value))

export function parseKnowledgeConsumerBindingInput(input: unknown): KnowledgeConsumerBindingInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_INPUT')
  const row = input as Record<string, unknown>
  if (Reflect.ownKeys(row).length !== INPUT_KEYS.length || INPUT_KEYS.some(key => !Object.hasOwn(row, key))) return fail('INVALID_INPUT')
  if (typeof row.consumerKind !== 'string' || !['geo_dataset', 'benchmark_prompt'].includes(row.consumerKind) || !validId(row.consumerId) || typeof row.subjectKind !== 'string' || !['entity', 'claim', 'source'].includes(row.subjectKind) || !validId(row.subjectId) || typeof row.operation !== 'string' || !['bind', 'revoke'].includes(row.operation)) return fail('INVALID_INPUT')
  if (row.expectedBindingFingerprint !== null && !validHash(row.expectedBindingFingerprint)) return fail('INVALID_INPUT')
  if (row.operation === 'bind' ? !validHash(row.expectedRevisionFingerprint) : row.expectedRevisionFingerprint !== null || !validHash(row.expectedBindingFingerprint)) return fail('INVALID_INPUT')
  if (typeof row.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/u.test(row.idempotencyKey)) return fail('INVALID_INPUT')
  return { consumerKind: row.consumerKind as KnowledgeConsumerBindingInput['consumerKind'], consumerId: row.consumerId, subjectKind: row.subjectKind as KnowledgeConsumerBindingInput['subjectKind'], subjectId: row.subjectId, operation: row.operation as 'bind' | 'revoke', expectedRevisionFingerprint: row.expectedRevisionFingerprint as string | null, expectedBindingFingerprint: row.expectedBindingFingerprint as string | null, idempotencyKey: row.idempotencyKey }
}

export function assertValidKnowledgeConsumerAnchor(anchor: KnowledgeConsumerAnchor): void {
  if (!validId(anchor.ownerUserId) || !validId(anchor.consumerId) || !validHash(anchor.consumerContentHash) || typeof anchor.consumerVersion !== 'string') return fail('CORRUPT_STATE')
  if (anchor.consumerKind === 'geo_dataset') {
    if (anchor.consumerVersion !== anchor.consumerContentHash) return fail('CORRUPT_STATE')
  } else if (anchor.consumerKind !== 'benchmark_prompt' || !/^[1-9]\d{0,9}$/u.test(anchor.consumerVersion) || Number(anchor.consumerVersion) > 2_147_483_647) return fail('CORRUPT_STATE')
}

function requestFor(record: Omit<KnowledgeConsumerBinding, 'id'>): KnowledgeConsumerBindingInput {
  return { consumerKind: record.consumerKind, consumerId: record.consumerId, subjectKind: record.subjectKind, subjectId: record.subjectId, operation: record.operation, expectedRevisionFingerprint: record.operation === 'bind' ? record.revisionFingerprint : null, expectedBindingFingerprint: record.previousBindingFingerprint, idempotencyKey: record.idempotencyKey }
}
export function knowledgeConsumerBindingFingerprint(record: Omit<KnowledgeConsumerBinding, 'id'>): string {
  const { createdAt: _createdAt, bindingFingerprint: _bindingFingerprint, ...body } = record
  // DB IDs and timestamp precision do not change immutable semantic identity.
  const { id: _id, ...withoutId } = body as typeof body & { id?: number }
  return fingerprint({ schemaVersion: 'knowledge-consumer-binding-v1', ...withoutId })
}
export function assertValidKnowledgeConsumerBinding(record: KnowledgeConsumerBinding | Omit<KnowledgeConsumerBinding, 'id'>): void {
  let expected: KnowledgeConsumerBindingInput
  try { expected = parseKnowledgeConsumerBindingInput(requestFor(record)) } catch { return fail('CORRUPT_STATE') }
  if (!validId(record.ownerUserId) || !validId(record.revisionId) || !validId(record.revisionNumber) || !validId(record.sequenceNumber) || !validHash(record.revisionContentHash) || !validHash(record.revisionFingerprint) || !validHash(record.consumerContentHash) || typeof record.consumerVersion !== 'string' || !record.consumerVersion.length || record.consumerVersion.length > 80 || !(record.createdAt instanceof Date) || !Number.isFinite(record.createdAt.getTime())) return fail('CORRUPT_STATE')
  if ((record.sequenceNumber === 1) !== (record.previousBindingFingerprint === null) || record.operation === 'revoke' && record.sequenceNumber === 1 || fingerprint(expected) !== record.requestFingerprint || knowledgeConsumerBindingFingerprint(record) !== record.bindingFingerprint) return fail('CORRUPT_STATE')
  if ('id' in record && !validId(record.id) || /[\u0000-\u001f\u007f]/u.test(record.consumerVersion) || (record.consumerKind === 'geo_dataset' ? record.consumerVersion !== record.consumerContentHash : !/^[1-9]\d{0,9}$/u.test(record.consumerVersion) || Number(record.consumerVersion) > 2_147_483_647)) return fail('CORRUPT_STATE')
}

async function assertBindingPredecessor(row: KnowledgeConsumerBinding, repository: KnowledgeConsumerBindingRepository, batch?: import('./consumer-binding-types').KnowledgeConsumerBindingAuthorities): Promise<void> {
  if (row.previousBindingFingerprint === null) return
  const previous = batch ? batch.predecessors.get(row.previousBindingFingerprint) : await repository.getBindingByFingerprint(row.ownerUserId, row.previousBindingFingerprint)
  if (!previous) return fail('CORRUPT_STATE')
  assertValidKnowledgeConsumerBinding(previous)
  if (previous.ownerUserId !== row.ownerUserId || previous.consumerKind !== row.consumerKind || previous.consumerId !== row.consumerId || previous.subjectKind !== row.subjectKind || previous.subjectId !== row.subjectId || previous.sequenceNumber !== row.sequenceNumber - 1 || previous.bindingFingerprint !== row.previousBindingFingerprint) return fail('CORRUPT_STATE')
}

export async function mutateKnowledgeConsumerBinding(ownerUserId: number, rawInput: unknown, repository: KnowledgeConsumerBindingRepository, now = new Date()) {
  if (!validId(ownerUserId) || !Number.isFinite(now.getTime())) return fail('INVALID_INPUT')
  const input = parseKnowledgeConsumerBindingInput(rawInput)
  const requestFingerprint = fingerprint(input)
  return repository.transaction(async tx => {
    const subject = { kind: input.subjectKind, id: input.subjectId }
    // Canonical subject lock serializes this binding with Knowledge edits and competing commands.
    await tx.knowledge.lockRevisionSubject(ownerUserId, subject)
    const command = await tx.getCommand(ownerUserId, input.idempotencyKey)
    if (command) {
      assertValidKnowledgeConsumerBinding(command)
      await assertBindingPredecessor(command, tx)
      if (command.ownerUserId !== ownerUserId || command.requestFingerprint !== requestFingerprint) return fail('CONFLICT')
      return bindingReceipt(command, true)
    }
    const previous = await tx.getBindingHead(ownerUserId, input)
    if (previous) { assertValidKnowledgeConsumerBinding(previous); await assertBindingPredecessor(previous, tx) }
    if ((previous?.bindingFingerprint ?? null) !== input.expectedBindingFingerprint) return fail('CONFLICT')
    if (previous && (previous.ownerUserId !== ownerUserId || previous.consumerKind !== input.consumerKind || previous.consumerId !== input.consumerId || previous.subjectKind !== input.subjectKind || previous.subjectId !== input.subjectId)) return fail('CORRUPT_STATE')
    let base: Pick<KnowledgeConsumerBinding, 'consumerVersion' | 'consumerContentHash' | 'revisionId' | 'revisionNumber' | 'revisionContentHash' | 'revisionFingerprint'>
    if (input.operation === 'revoke') {
      if (!previous || previous.operation !== 'bind') return fail('CONFLICT')
      // Revocation remains available after native deletion or Knowledge drift.
      base = previous
    } else {
      const anchor = await tx.getNativeAnchor(ownerUserId, input.consumerKind, input.consumerId, true)
      if (!anchor) return fail('NOT_FOUND')
      assertValidKnowledgeConsumerAnchor(anchor)
      if (anchor.ownerUserId !== ownerUserId || anchor.consumerKind !== input.consumerKind || anchor.consumerId !== input.consumerId) return fail('CORRUPT_STATE')
      const head = await tx.knowledge.getRevisionHead(ownerUserId, subject)
      if (!head) return fail('REVISION_REQUIRED')
      assertValidKnowledgeRevision(head)
      if (head.ownerUserId !== ownerUserId || head.subjectKind !== input.subjectKind || head.subjectId !== input.subjectId) return fail('CORRUPT_STATE')
      if (head.revisionFingerprint !== input.expectedRevisionFingerprint) return fail('CONFLICT')
      const current = await buildKnowledgeRevisionSnapshot(tx.knowledge, ownerUserId, subject)
      if (current.contentHash !== head.contentHash || current.canonicalSnapshot !== head.canonicalSnapshot) return fail('CONFLICT')
      const event = await tx.knowledge.getMutationEventForRevision(ownerUserId, head.revisionFingerprint)
      if (!event) return fail('CORRUPT_STATE')
      assertValidKnowledgeMutationEvent(event)
      if (event.ownerUserId !== ownerUserId || event.subjectKind !== input.subjectKind || event.subjectId !== input.subjectId || event.revisionId !== head.id || event.revisionNumber !== head.revisionNumber || event.newRevisionFingerprint !== head.revisionFingerprint || event.previousRevisionFingerprint !== head.previousRevisionFingerprint || event.operations.join(',') !== head.operations.join(',')) return fail('CORRUPT_STATE')
      base = { ...anchor, revisionId: head.id, revisionNumber: head.revisionNumber, revisionContentHash: head.contentHash, revisionFingerprint: head.revisionFingerprint }
      if (previous?.operation === 'bind' && previous.consumerVersion === base.consumerVersion && previous.consumerContentHash === base.consumerContentHash && previous.revisionFingerprint === base.revisionFingerprint) return fail('CONFLICT')
    }
    const record: Omit<KnowledgeConsumerBinding, 'id'> = { ownerUserId, consumerKind: input.consumerKind, consumerId: input.consumerId, consumerVersion: base.consumerVersion, consumerContentHash: base.consumerContentHash, subjectKind: input.subjectKind, subjectId: input.subjectId, revisionId: base.revisionId, revisionNumber: base.revisionNumber, revisionContentHash: base.revisionContentHash, revisionFingerprint: base.revisionFingerprint, operation: input.operation, sequenceNumber: (previous?.sequenceNumber ?? 0) + 1, previousBindingFingerprint: previous?.bindingFingerprint ?? null, requestFingerprint, idempotencyKey: input.idempotencyKey, createdAt: now, bindingFingerprint: '' }
    const complete = { ...record, bindingFingerprint: knowledgeConsumerBindingFingerprint(record) }
    assertValidKnowledgeConsumerBinding(complete)
    const saved = await tx.appendBinding(complete)
    assertValidKnowledgeConsumerBinding(saved)
    if (saved.ownerUserId !== ownerUserId || saved.bindingFingerprint !== complete.bindingFingerprint) return fail('CORRUPT_STATE')
    return bindingReceipt(saved, false)
  })
}

function bindingSummary(row: KnowledgeConsumerBinding): KnowledgeConsumerBindingSummary {
  return { id: row.id, consumerKind: row.consumerKind, consumerId: row.consumerId, consumerVersion: row.consumerVersion, consumerContentHash: row.consumerContentHash, subjectKind: row.subjectKind, subjectId: row.subjectId, revisionId: row.revisionId, revisionNumber: row.revisionNumber, revisionContentHash: row.revisionContentHash, revisionFingerprint: row.revisionFingerprint, operation: row.operation, sequenceNumber: row.sequenceNumber, bindingFingerprint: row.bindingFingerprint, previousBindingFingerprint: row.previousBindingFingerprint }
}

function bindingReceipt(row: KnowledgeConsumerBinding, replayed: boolean) {
  return { binding: bindingSummary(row), replayed, automaticPublication: false as const, automaticTrainingAdmission: false as const, productionActivation: false as const }
}

export async function readKnowledgeConsumerBindingWorkspace(ownerUserId: number, repository: KnowledgeConsumerBindingRepository): Promise<{ coverage: KnowledgeImpactAdapterCoverage[], bindings: KnowledgeConsumerBindingHeadSummary[] }> {
  if (!validId(ownerUserId)) return fail('INVALID_INPUT')
  const rows = await repository.listBindingHeads(ownerUserId, 2_001)
  if (rows.length > 2_000) return fail('LIMIT_EXCEEDED')
  // Validate scope before handing IDs to the native batch adapter.
  for (const row of rows) { assertValidKnowledgeConsumerBinding(row); if (row.ownerUserId !== ownerUserId) return fail('CORRUPT_STATE') }
  const batch = repository.loadAuthorities ? await repository.loadAuthorities(ownerUserId, rows) : undefined
  const groups = new Map<string, KnowledgeImpactConsumerRef & { dependencies: KnowledgeImpactConsumerRef['dependencies'][number][] }>()
  const anchors = new Map<string, Awaited<ReturnType<KnowledgeConsumerBindingRepository['getNativeAnchor']>>>()
  const revisions = new Map<number, Awaited<ReturnType<KnowledgeConsumerBindingRepository['getBoundRevision']>>>()
  const bindings: KnowledgeConsumerBindingHeadSummary[] = []
  for (const row of rows) {
    assertValidKnowledgeConsumerBinding(row)
    if (row.ownerUserId !== ownerUserId) return fail('CORRUPT_STATE')
    await assertBindingPredecessor(row, repository, batch)
    const key = `${row.consumerKind}:${row.consumerId}`
    if (!anchors.has(key)) anchors.set(key, batch ? batch.anchors.get(key) ?? null : await repository.getNativeAnchor(ownerUserId, row.consumerKind, row.consumerId))
    const anchor = anchors.get(key)
    if (anchor) assertValidKnowledgeConsumerAnchor(anchor)
    if (anchor && (anchor.ownerUserId !== ownerUserId || anchor.consumerKind !== row.consumerKind || anchor.consumerId !== row.consumerId || anchor.consumerVersion !== row.consumerVersion || anchor.consumerContentHash !== row.consumerContentHash)) return fail('CORRUPT_STATE')
    if (!revisions.has(row.revisionId)) revisions.set(row.revisionId, batch ? batch.revisions.get(row.revisionId) ?? null : await repository.getBoundRevision(ownerUserId, row.revisionId))
    const revision = revisions.get(row.revisionId)
    if (!revision) return fail('CORRUPT_STATE')
    assertValidKnowledgeRevision(revision)
    if (revision.ownerUserId !== ownerUserId || revision.subjectKind !== row.subjectKind || revision.subjectId !== row.subjectId || revision.revisionNumber !== row.revisionNumber || revision.contentHash !== row.revisionContentHash || revision.revisionFingerprint !== row.revisionFingerprint) return fail('CORRUPT_STATE')
    const event = batch ? batch.events.get(revision.id) : await repository.knowledge.getMutationEventForRevision(ownerUserId, revision.revisionFingerprint)
    if (!event) return fail('CORRUPT_STATE')
    assertValidKnowledgeMutationEvent(event)
    if (event.ownerUserId !== ownerUserId || event.subjectKind !== row.subjectKind || event.subjectId !== row.subjectId || event.revisionId !== revision.id || event.revisionNumber !== revision.revisionNumber || event.newRevisionFingerprint !== revision.revisionFingerprint || event.previousRevisionFingerprint !== revision.previousRevisionFingerprint || event.operations.join(',') !== revision.operations.join(',')) return fail('CORRUPT_STATE')
    bindings.push({ ...bindingSummary(row), nativeAvailability: anchor ? 'present' : 'missing' })
    if (row.operation === 'revoke') continue
    const existing = groups.get(key)
    const consumer = existing ?? { category: row.consumerKind === 'geo_dataset' ? 'dataset' as const : 'benchmark_prompt' as const, ownerUserId, consumerId: key, version: row.consumerVersion, contentHash: row.consumerContentHash, ...(!anchor ? { nativeAvailability: 'missing' as const } : {}), dependencies: [] }
    if (consumer.dependencies.some(dependency => dependency.kind === row.subjectKind && dependency.id === row.subjectId)) return fail('CORRUPT_STATE')
    consumer.dependencies.push({ kind: row.subjectKind, id: row.subjectId, version: row.revisionNumber, contentHash: row.revisionContentHash, revisionFingerprint: row.revisionFingerprint })
    groups.set(key, consumer)
  }
  for (const category of ['dataset', 'benchmark_prompt']) if ([...groups.values()].filter(consumer => consumer.category === category).length > KNOWLEDGE_IMPACT_MAX_CONSUMERS_PER_CATEGORY) return fail('LIMIT_EXCEEDED')
  const coverage = createNativeKnowledgeImpactCoverage().map(item => item.category === 'dataset' || item.category === 'benchmark_prompt' ? { ...item, state: 'complete' as const, scope: 'native_explicit_revision_bindings_v1', limitationCodes: ['scope_excludes_unregistered_consumers', 'binding_is_not_training_or_publication_approval', ...([...groups.values()].some(consumer => consumer.category === item.category && consumer.nativeAvailability === 'missing') ? ['native_consumer_missing'] : [])], consumers: [...groups.values()].filter(consumer => consumer.category === item.category) } : item)
  return { coverage, bindings }
}

export async function readKnowledgeConsumerCoverage(ownerUserId: number, repository: KnowledgeConsumerBindingRepository): Promise<KnowledgeImpactAdapterCoverage[]> {
  return (await readKnowledgeConsumerBindingWorkspace(ownerUserId, repository)).coverage
}
