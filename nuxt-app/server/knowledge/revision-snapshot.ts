import { createHash } from 'node:crypto'
import type {
  KnowledgeClaim,
  KnowledgeClaimEntityLink,
  KnowledgeClaimEvidence,
  KnowledgeContentEntityLink,
  KnowledgeEntity,
  KnowledgeEntityAlias,
  KnowledgeEntityExternalId,
  KnowledgeRepository,
  KnowledgeSource,
  KnowledgeSourceVersion,
} from './types'
import { KNOWLEDGE_CLAIM_STATUSES, KNOWLEDGE_CLAIM_TYPES, KNOWLEDGE_ENTITY_TYPES, KNOWLEDGE_SOURCE_CLASSES } from './types'
import { KNOWLEDGE_REVISION_SCHEMA, type KnowledgeRevisionSubject } from './revision-types'

const MAX_ROWS_PER_COLLECTION = 2000
const READ_SENTINEL = MAX_ROWS_PER_COLLECTION + 1
const MAX_SNAPSHOT_BYTES = 65_536
const MAX_CANONICAL_DEPTH = 20
const MAX_CANONICAL_NODES = 20_000

export interface KnowledgeRevisionSnapshot {
  readonly canonicalSnapshot: string
  readonly contentHash: string
}
export type KnowledgeRevisionSnapshotErrorCode = 'CORRUPT_STATE' | 'LIMIT_EXCEEDED' | 'SUBJECT_NOT_FOUND'

const ERROR_MESSAGES: Record<KnowledgeRevisionSnapshotErrorCode, string> = {
  CORRUPT_STATE: 'Knowledge revision snapshot contains invalid state.',
  LIMIT_EXCEEDED: 'Knowledge revision snapshot exceeds a safety limit.',
  SUBJECT_NOT_FOUND: 'Knowledge revision subject was not found.',
}

export class KnowledgeRevisionSnapshotError extends Error {
  constructor(readonly code: KnowledgeRevisionSnapshotErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'KnowledgeRevisionSnapshotError'
  }
}

function fail(code: KnowledgeRevisionSnapshotErrorCode): never { throw new KnowledgeRevisionSnapshotError(code) }
function corrupt(): never { return fail('CORRUPT_STATE') }
function limited(): never { return fail('LIMIT_EXCEEDED') }
function notFound(): never { return fail('SUBJECT_NOT_FOUND') }
function positiveId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function validHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function validText(value: unknown, nullable = false): value is string | null {
  return (nullable && value === null) || (typeof value === 'string' && value.length > 0)
}

function isoDate(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return corrupt()
  return value.toISOString()
}

interface CanonicalContext { readonly seen: Set<object>; nodes: number }

function canonicalJson(value: unknown, context: CanonicalContext = { seen: new Set<object>(), nodes: 0 }, depth = 0): string {
  context.nodes += 1
  if (context.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) return limited()
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    const result = JSON.stringify(value)
    if (Buffer.byteLength(result, 'utf8') > MAX_SNAPSHOT_BYTES) return limited()
    return result
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return corrupt()
    const result = JSON.stringify(value)
    if (Buffer.byteLength(result, 'utf8') > MAX_SNAPSHOT_BYTES) return limited()
    return result
  }
  if (value instanceof Date) return canonicalJson(isoDate(value), context, depth + 1)
  if (typeof value !== 'object') return corrupt()
  if (context.seen.has(value)) return corrupt()
  context.seen.add(value)
  let result: string
  if (Array.isArray(value)) {
    result = `[${value.map(item => canonicalJson(item, context, depth + 1)).join(',')}]`
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return corrupt()
    const record = value as Record<string, unknown>
    result = `{${Object.keys(record).sort(compareText).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], context, depth + 1)}`).join(',')}}`
  }
  context.seen.delete(value)
  if (Buffer.byteLength(result, 'utf8') > MAX_SNAPSHOT_BYTES) return limited()
  return result
}

function digestHidden(value: unknown): string {
  const canonical = canonicalJson(value)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function validateBase(record: { id: number; ownerUserId: number; createdAt: Date; updatedAt: Date }, ownerUserId: number): void {
  if (!positiveId(record.id) || record.ownerUserId !== ownerUserId) corrupt()
  isoDate(record.createdAt)
  isoDate(record.updatedAt)
}

function boundedRows<T>(rows: T[], ownerUserId: number, withBase: (row: T) => { id: number; ownerUserId: number; createdAt: Date; updatedAt: Date }): T[] {
  if (!Array.isArray(rows)) corrupt()
  if (rows.length > MAX_ROWS_PER_COLLECTION) limited()
  const ids = new Set<number>()
  for (const row of rows) {
    if (!isRecord(row)) corrupt()
    const base = withBase(row)
    validateBase(base, ownerUserId)
    if (ids.has(base.id)) corrupt()
    ids.add(base.id)
  }
  return rows
}

function entitySemantics(entity: KnowledgeEntity): Record<string, unknown> {
  if (!validText(entity.entityUid) || !KNOWLEDGE_ENTITY_TYPES.includes(entity.entityType) || !validText(entity.canonicalName)
    || !validText(entity.slug, true) || !validText(entity.canonicalUri, true) || !validText(entity.locale, true)
    || !validText(entity.summary, true) || !['active', 'merged', 'retired'].includes(entity.status)
    || !['private', 'public_candidate'].includes(entity.publicVisibility)
    || (entity.canonicalUriHash !== null && !validHash(entity.canonicalUriHash))) corrupt()
  if (entity.mergedIntoEntityId !== null && !positiveId(entity.mergedIntoEntityId)) corrupt()
  return {
    id: entity.id,
    entityUid: entity.entityUid,
    entityType: entity.entityType,
    canonicalName: entity.canonicalName,
    slug: entity.slug,
    canonicalUriDigest: digestHidden(entity.canonicalUri),
    canonicalUriHash: entity.canonicalUriHash,
    locale: entity.locale,
    summary: entity.summary,
    status: entity.status,
    publicVisibility: entity.publicVisibility,
    mergedIntoEntityId: entity.mergedIntoEntityId,
    provenanceDigest: digestHidden(entity.provenance),
  }
}

function sourceVersionSemantics(version: KnowledgeSourceVersion): Record<string, unknown> {
  validateBase(version, version.ownerUserId)
  if (!positiveId(version.sourceId) || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1 || !validHash(version.contentHash)) corrupt()
  return {
    id: version.id,
    sourceId: version.sourceId,
    versionNumber: version.versionNumber,
    contentHash: version.contentHash,
    retrievedAt: isoDate(version.retrievedAt),
    excerptDigest: digestHidden(version.excerpt),
    metadataDigest: digestHidden(version.metadata),
  }
}

function sourceSemantics(source: KnowledgeSource): Record<string, unknown> {
  if (!validText(source.canonicalUrl) || !validHash(source.urlHash) || !validText(source.title, true)
    || !KNOWLEDGE_SOURCE_CLASSES.includes(source.sourceClass) || !['active', 'archived'].includes(source.status)) corrupt()
  return {
    id: source.id,
    canonicalUrlDigest: digestHidden(source.canonicalUrl),
    urlHash: source.urlHash,
    title: source.title,
    sourceClass: source.sourceClass,
    status: source.status,
    notesDigest: digestHidden(source.notes),
  }
}

function claimSemantics(claim: KnowledgeClaim): Record<string, unknown> {
  if (!validText(claim.statement) || !KNOWLEDGE_CLAIM_TYPES.includes(claim.claimType) || !KNOWLEDGE_CLAIM_STATUSES.includes(claim.status)) corrupt()
  return {
    id: claim.id,
    statement: claim.statement,
    claimType: claim.claimType,
    status: claim.status,
    validFrom: claim.validFrom === null ? null : isoDate(claim.validFrom),
    validTo: claim.validTo === null ? null : isoDate(claim.validTo),
  }
}

function validateLink(row: KnowledgeClaimEntityLink | KnowledgeContentEntityLink, ownerUserId: number): void {
  validateBase(row, ownerUserId)
  if (!positiveId(row.entityId)) corrupt()
}

function aliasSemantics(row: KnowledgeEntityAlias): Record<string, unknown> {
  if (!positiveId(row.entityId) || !validText(row.alias) || !validText(row.aliasNormalized) || !validText(row.locale, true)) corrupt()
  return { id: row.id, entityId: row.entityId, alias: row.alias, aliasNormalized: row.aliasNormalized, locale: row.locale }
}

function externalIdSemantics(row: KnowledgeEntityExternalId): Record<string, unknown> {
  if (!positiveId(row.entityId) || !validText(row.idType) || !validText(row.idValue)) corrupt()
  return { id: row.id, entityId: row.entityId, idType: row.idType, idValue: row.idValue }
}

function claimLinkSemantics(row: KnowledgeClaimEntityLink): Record<string, unknown> {
  if (!positiveId(row.claimId) || !positiveId(row.entityId)) corrupt()
  return { id: row.id, claimId: row.claimId, entityId: row.entityId }
}

function evidenceSemantics(row: KnowledgeClaimEvidence): Record<string, unknown> {
  if (!positiveId(row.claimId) || !positiveId(row.sourceVersionId) || !['supports', 'contradicts', 'contextualizes', 'supersedes'].includes(row.relation)
    || !validText(row.locator) || !validHash(row.locatorHash) || !validHash(row.contentHash) || !validText(row.reviewNotes, true)) corrupt()
  return {
    id: row.id,
    claimId: row.claimId,
    sourceVersionId: row.sourceVersionId,
    relation: row.relation,
    locatorHash: row.locatorHash,
    contentHash: row.contentHash,
    reviewNotesDigest: digestHidden(row.reviewNotes),
  }
}

async function mergeRedirect(ownerUserId: number, entity: KnowledgeEntity, repository: KnowledgeRepository): Promise<Record<string, unknown>> {
  if ((entity.status === 'merged') !== (entity.mergedIntoEntityId !== null)) corrupt()
  const visited = new Set<number>([entity.id])
  let nextId = entity.mergedIntoEntityId
  while (nextId !== null) {
    if (!positiveId(nextId) || visited.has(nextId) || visited.size > 10) corrupt()
    visited.add(nextId)
    const next = await repository.getEntity(ownerUserId, nextId)
    if (!next) corrupt()
    validateBase(next, ownerUserId)
    if ((next.status === 'merged') !== (next.mergedIntoEntityId !== null)) corrupt()
    nextId = next.mergedIntoEntityId
  }
  return { directTargetId: entity.mergedIntoEntityId }
}

async function entitySnapshot(ownerUserId: number, entity: KnowledgeEntity, repository: KnowledgeRepository): Promise<Record<string, unknown>> {
  validateBase(entity, ownerUserId)
  const [aliasesRaw, externalIdsRaw, claimLinksRaw, contentLinksRaw, publisher] = await Promise.all([
    repository.listEntityAliases(ownerUserId, entity.id, READ_SENTINEL),
    repository.listEntityExternalIds(ownerUserId, entity.id, READ_SENTINEL),
    repository.listClaimEntityLinks(ownerUserId, undefined, READ_SENTINEL),
    repository.listContentEntityLinks(ownerUserId, undefined, READ_SENTINEL),
    repository.getPublisherSetting(ownerUserId),
  ])
  const aliases = boundedRows(aliasesRaw, ownerUserId, row => row)
    .map(row => {
      if (row.entityId !== entity.id) corrupt()
      return aliasSemantics(row)
    }).sort((a, b) => Number(a.id) - Number(b.id))
  const externalIds = boundedRows(externalIdsRaw, ownerUserId, row => row)
    .map(row => {
      if (row.entityId !== entity.id) corrupt()
      return externalIdSemantics(row)
    }).sort((a, b) => Number(a.id) - Number(b.id))
  const claimLinks = boundedRows(claimLinksRaw, ownerUserId, row => row)
  const relatedClaimLinks = claimLinks.filter(row => row.entityId === entity.id)
  for (const link of relatedClaimLinks) {
    validateLink(link, ownerUserId)
    if (!positiveId(link.claimId) || !(await repository.getClaim(ownerUserId, link.claimId))) corrupt()
  }
  const contentLinks = boundedRows(contentLinksRaw, ownerUserId, row => row)
    .filter(row => row.entityId === entity.id)
  const contentLinkItems = contentLinks.map(row => {
    validateLink(row, ownerUserId)
    if (!positiveId(row.briefId) || !['author', 'about', 'mentions'].includes(row.role)) corrupt()
    return { id: row.id, briefId: row.briefId, entityId: row.entityId, role: row.role }
  }).sort((a, b) => a.briefId - b.briefId || compareText(a.role, b.role) || a.id - b.id)
  let publisherSemantics: Record<string, unknown> | null = null
  if (publisher) {
    validateBase(publisher, ownerUserId)
    if (!positiveId(publisher.organizationEntityId)) corrupt()
    const organization = await repository.getEntity(ownerUserId, publisher.organizationEntityId)
    if (!organization) corrupt()
    validateBase(organization, ownerUserId)
    publisherSemantics = organization.id === entity.id ? { selected: true, settingId: publisher.id } : { selected: false, settingId: null }
  } else {
    publisherSemantics = { selected: false, settingId: null }
  }
  const redirect = await mergeRedirect(ownerUserId, entity, repository)
  return {
    kind: 'entity',
    subject: entitySemantics(entity),
    aliases,
    externalIds,
    claimEntityLinks: relatedClaimLinks.map(claimLinkSemantics).sort((a, b) => Number(a.id) - Number(b.id)),
    contentEntityLinks: contentLinkItems,
    publisherSetting: publisherSemantics,
    mergeRedirect: redirect,
  }
}

async function claimSnapshot(ownerUserId: number, claim: KnowledgeClaim, repository: KnowledgeRepository): Promise<Record<string, unknown>> {
  validateBase(claim, ownerUserId)
  const [linksRaw, evidenceRaw] = await Promise.all([
    repository.listClaimEntityLinks(ownerUserId, claim.id, READ_SENTINEL),
    repository.listClaimEvidence(ownerUserId, claim.id, READ_SENTINEL),
  ])
  const links = boundedRows(linksRaw, ownerUserId, row => row)
  if (links.some(row => row.claimId !== claim.id)) corrupt()
  for (const link of links) {
    validateLink(link, ownerUserId)
    if (link.claimId !== claim.id || !(await repository.getEntity(ownerUserId, link.entityId))) corrupt()
  }
  const evidence = boundedRows(evidenceRaw, ownerUserId, row => row)
  if (evidence.some(row => row.claimId !== claim.id)) corrupt()
  const versionsById = new Map<number, KnowledgeSourceVersion>()
  for (const row of evidence) {
    validateBase(row, ownerUserId)
    if (row.claimId !== claim.id || !positiveId(row.sourceVersionId)) corrupt()
    if (!/^[a-f0-9]{64}$/u.test(row.locatorHash) || !/^[a-f0-9]{64}$/u.test(row.contentHash)) corrupt()
    const version = await repository.getSourceVersion(ownerUserId, row.sourceVersionId)
    if (!version) corrupt()
    validateBase(version, ownerUserId)
    if (version.ownerUserId !== ownerUserId || !positiveId(version.sourceId) || !validHash(version.contentHash) || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1) corrupt()
    isoDate(version.retrievedAt)
    const source = await repository.getSource(ownerUserId, version.sourceId)
    if (!source) corrupt()
    validateBase(source, ownerUserId)
    sourceVersionSemantics(version)
    versionsById.set(version.id, version)
  }
  const semanticEvidence = evidence.map(evidenceSemantics).sort((a, b) => Number(a.id) - Number(b.id))
  const semanticVersions = [...versionsById.values()].map(sourceVersionSemantics).sort((a, b) => Number(a.sourceId) - Number(b.sourceId) || Number(a.versionNumber) - Number(b.versionNumber) || Number(a.id) - Number(b.id))
  return {
    kind: 'claim',
    subject: claimSemantics(claim),
    claimEntityLinks: links.map(claimLinkSemantics).sort((a, b) => Number(a.id) - Number(b.id)),
    evidence: semanticEvidence,
    sourceVersions: semanticVersions,
  }
}

async function sourceSnapshot(ownerUserId: number, source: KnowledgeSource, repository: KnowledgeRepository): Promise<Record<string, unknown>> {
  validateBase(source, ownerUserId)
  if (!/^[a-f0-9]{64}$/u.test(source.urlHash)) corrupt()
  const versionsRaw = await repository.listSourceVersions(ownerUserId, source.id, READ_SENTINEL)
  const versions = boundedRows(versionsRaw, ownerUserId, row => row)
  if (versions.some(row => row.sourceId !== source.id)) corrupt()
  for (const version of versions) {
    if (version.sourceId !== source.id || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1 || !validHash(version.contentHash)) corrupt()
    isoDate(version.retrievedAt)
  }
  const versionNumbers = new Set<number>()
  for (const version of versions) {
    if (versionNumbers.has(version.versionNumber)) corrupt()
    versionNumbers.add(version.versionNumber)
  }
  return {
    kind: 'source',
    subject: sourceSemantics(source),
    sourceVersions: versions.map(sourceVersionSemantics).sort((a, b) => Number(a.versionNumber) - Number(b.versionNumber) || Number(a.id) - Number(b.id)),
  }
}

export async function buildKnowledgeRevisionSnapshot(repository: KnowledgeRepository, ownerUserId: number, subject: KnowledgeRevisionSubject): Promise<KnowledgeRevisionSnapshot> {
  if (!positiveId(ownerUserId) || !subject || !['entity', 'claim', 'source'].includes(subject.kind) || !positiveId(subject.id)) corrupt()
  let snapshot: Record<string, unknown>
  if (subject.kind === 'entity') {
    const entity = await repository.getEntity(ownerUserId, subject.id)
    if (!entity) notFound()
    snapshot = await entitySnapshot(ownerUserId, entity, repository)
  } else if (subject.kind === 'claim') {
    const claim = await repository.getClaim(ownerUserId, subject.id)
    if (!claim) notFound()
    snapshot = await claimSnapshot(ownerUserId, claim, repository)
  } else {
    const source = await repository.getSource(ownerUserId, subject.id)
    if (!source) notFound()
    snapshot = await sourceSnapshot(ownerUserId, source, repository)
  }
  const canonicalSnapshot = canonicalJson({ schemaVersion: KNOWLEDGE_REVISION_SCHEMA, ownerUserId, ...snapshot })
  if (Buffer.byteLength(canonicalSnapshot, 'utf8') > MAX_SNAPSHOT_BYTES) limited()
  const contentHash = createHash('sha256').update(canonicalSnapshot, 'utf8').digest('hex')
  return { canonicalSnapshot, contentHash }
}
