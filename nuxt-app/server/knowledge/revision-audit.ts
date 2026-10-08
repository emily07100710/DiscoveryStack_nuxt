import type { KnowledgeRepository } from './types'
import { buildKnowledgeRevisionSnapshot } from './revision-snapshot'
import {
  KNOWLEDGE_REVISION_SCHEMA,
  KnowledgeRevisionError,
  type KnowledgeMutationEvent,
  type KnowledgeRevision,
  type KnowledgeRevisionSubject,
} from './revision-types'
import type { NewKnowledgeRecord } from './types'
import { assertValidKnowledgeMutationEvent, assertValidKnowledgeRevision, knowledgeMutationEventFingerprint, knowledgeRevisionFingerprint } from './revision-records'

export interface KnowledgeRevisionAuditChange {
  readonly subject: KnowledgeRevisionSubject
  readonly beforeSnapshot: string | null
  readonly beforeHash: string | null
  readonly operations: Set<string>
}

export async function captureKnowledgeRevisionBefore(ownerUserId: number, repository: KnowledgeRepository, subject: KnowledgeRevisionSubject): Promise<KnowledgeRevisionAuditChange> {
  await repository.lockRevisionSubject(ownerUserId, subject)
  const snapshot = await buildKnowledgeRevisionSnapshot(repository, ownerUserId, subject)
  return { subject, beforeSnapshot: snapshot.canonicalSnapshot, beforeHash: snapshot.contentHash, operations: new Set() }
}

export async function flushKnowledgeRevisionAudit(ownerUserId: number, repository: KnowledgeRepository, changes: Map<string, KnowledgeRevisionAuditChange>, now = new Date()): Promise<void> {
  const ordered = [...changes.values()].sort((a, b) => a.subject.kind.localeCompare(b.subject.kind) || a.subject.id - b.subject.id)
  for (const change of ordered) {
    const after = await buildKnowledgeRevisionSnapshot(repository, ownerUserId, change.subject)
    const operations = [...change.operations].sort()
    if (!operations.length) throw new KnowledgeRevisionError('CORRUPT_STATE')
    let previousRevisionFingerprint: string | null = null
    let revisionNumber = 1
    const head = await repository.getRevisionHead(ownerUserId, change.subject)
    if (head) {
      assertValidKnowledgeRevision(head)
      const expectedHeadFingerprint = knowledgeRevisionFingerprint(head)
      if (head.ownerUserId !== ownerUserId || head.subjectKind !== change.subject.kind || head.subjectId !== change.subject.id
        || head.revisionFingerprint !== expectedHeadFingerprint || head.contentHash !== change.beforeHash
        || head.canonicalSnapshot !== change.beforeSnapshot) {
        throw new KnowledgeRevisionError('REVISION_CONFLICT')
      }
      const event = await repository.getMutationEventForRevision(ownerUserId, head.revisionFingerprint)
      if (!event) throw new KnowledgeRevisionError('CORRUPT_STATE')
      assertValidKnowledgeMutationEvent(event)
      if (event.ownerUserId !== ownerUserId || event.subjectKind !== change.subject.kind || event.subjectId !== change.subject.id || event.revisionId !== head.id || event.revisionNumber !== head.revisionNumber || event.previousRevisionFingerprint !== head.previousRevisionFingerprint || event.newRevisionFingerprint !== head.revisionFingerprint || event.operations.join(',') !== head.operations.join(',')) throw new KnowledgeRevisionError('CORRUPT_STATE')
      if (change.beforeHash === after.contentHash && change.beforeSnapshot === after.canonicalSnapshot) continue
      previousRevisionFingerprint = head.revisionFingerprint
      revisionNumber = head.revisionNumber + 1
    } else if (change.beforeHash === after.contentHash && change.beforeSnapshot === after.canonicalSnapshot) {
      continue
    } else if (change.beforeSnapshot !== null && change.beforeHash !== null) {
      const baselineOperations = ['legacy_baseline']
      const baselineBase: Omit<NewKnowledgeRecord<KnowledgeRevision>, 'id'> = {
        ownerUserId, subjectKind: change.subject.kind, subjectId: change.subject.id,
        schemaVersion: KNOWLEDGE_REVISION_SCHEMA, revisionNumber: 1, revisionKind: 'legacy_baseline',
        canonicalSnapshot: change.beforeSnapshot, contentHash: change.beforeHash,
        previousRevisionFingerprint: null, revisionFingerprint: '', operations: baselineOperations,
        createdAt: now, updatedAt: now,
      }
      const baseline = { ...baselineBase, revisionFingerprint: knowledgeRevisionFingerprint(baselineBase) }
      assertValidKnowledgeRevision(baseline)
      const savedBaseline = await repository.appendRevision(baseline)
      const baselineEvent = {
        ownerUserId, subjectKind: change.subject.kind, subjectId: change.subject.id, revisionId: savedBaseline.id,
        revisionNumber: 1, previousRevisionFingerprint: null, newRevisionFingerprint: baseline.revisionFingerprint,
        eventFingerprint: '', operations: baselineOperations, createdAt: now, updatedAt: now,
      } satisfies NewKnowledgeRecord<KnowledgeMutationEvent>
      const baselineEventWithFingerprint = { ...baselineEvent, eventFingerprint: knowledgeMutationEventFingerprint(baselineEvent) }
      assertValidKnowledgeMutationEvent(baselineEventWithFingerprint)
      await repository.appendMutationEvent(baselineEventWithFingerprint)
      previousRevisionFingerprint = baseline.revisionFingerprint
      revisionNumber = 2
    }

    if (revisionNumber > 2_147_483_647) throw new KnowledgeRevisionError('LIMIT_EXCEEDED')
    const revisionKind = 'mutation' as const
    const revisionBase: Omit<NewKnowledgeRecord<KnowledgeRevision>, 'id'> = {
      ownerUserId, subjectKind: change.subject.kind, subjectId: change.subject.id,
      schemaVersion: KNOWLEDGE_REVISION_SCHEMA, revisionNumber, revisionKind,
      canonicalSnapshot: after.canonicalSnapshot, contentHash: after.contentHash,
      previousRevisionFingerprint, revisionFingerprint: '', operations,
      createdAt: now, updatedAt: now,
    }
    const revision = { ...revisionBase, revisionFingerprint: knowledgeRevisionFingerprint(revisionBase) }
    assertValidKnowledgeRevision(revision)
    const savedRevision = await repository.appendRevision(revision)
    const eventBase = {
      ownerUserId, subjectKind: change.subject.kind, subjectId: change.subject.id, revisionId: savedRevision.id,
      revisionNumber, previousRevisionFingerprint, newRevisionFingerprint: revision.revisionFingerprint,
      eventFingerprint: '', operations, createdAt: now, updatedAt: now,
    } satisfies NewKnowledgeRecord<KnowledgeMutationEvent>
    const eventWithFingerprint = { ...eventBase, eventFingerprint: knowledgeMutationEventFingerprint(eventBase) }
    assertValidKnowledgeMutationEvent(eventWithFingerprint)
    await repository.appendMutationEvent(eventWithFingerprint)
  }
}
