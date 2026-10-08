import { createHash } from 'node:crypto'
import {
  KNOWLEDGE_IMPACT_BUCKET_ORDER,
  KNOWLEDGE_IMPACT_MAX_CONSUMERS_PER_CATEGORY,
  KNOWLEDGE_IMPACT_MAX_ITEMS,
  KNOWLEDGE_IMPACT_MAX_REFERENCES,
  KNOWLEDGE_IMPACT_MAX_ROWS_PER_COLLECTION,
  KnowledgeImpactError,
  type KnowledgeImpactAdapterCoverage,
  type KnowledgeImpactBucket,
  type KnowledgeImpactCategory,
  type KnowledgeImpactConsumerRef,
  type KnowledgeImpactDependencyRef,
  type KnowledgeImpactItem,
  type KnowledgeImpactLineageRef,
  type KnowledgeImpactReport,
  type KnowledgeImpactSnapshot,
  type KnowledgeImpactSubject,
} from './impact-types'

const SHA256_RE = /^[a-f0-9]{64}$/u
const NATIVE_SCOPE = 'native_knowledge_bindings'
const MAX_JSON_BYTES = 512 * 1024

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function fingerprint(value: unknown): string {
  const serialized = canonical(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Impact snapshot exceeds the bounded fingerprint limit.')
  return sha256(serialized)
}

function corrupt(): never {
  throw new KnowledgeImpactError('CORRUPT_GRAPH', 'Knowledge impact snapshot contains an invalid or cross-owner reference.')
}

function overExpansionBudget(): never {
  throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Impact snapshot exceeds the bounded dependency expansion limit.')
}

/** Safe default: only the resolver's built-in native content/schema mappings are available. */
export function createNativeKnowledgeImpactCoverage(): KnowledgeImpactAdapterCoverage[] {
  return KNOWLEDGE_IMPACT_BUCKET_ORDER.map(category => ({
    category,
    state: 'unconfigured',
    scope: category === 'content' || category === 'schema' ? NATIVE_SCOPE : 'no exact consumer adapter configured',
    limitationCodes: category === 'content' || category === 'schema' ? [] : ['adapter_not_configured'],
    consumers: [],
  }))
}

function validateInput(ownerUserId: number, subject: KnowledgeImpactSubject, snapshot: KnowledgeImpactSnapshot): void {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || !Number.isSafeInteger(subject.id) || subject.id < 1) {
    throw new KnowledgeImpactError('INVALID_INPUT', 'Owner and subject identifiers must be positive safe integers.')
  }
  if (!['entity', 'claim', 'source'].includes(subject.kind)) throw new KnowledgeImpactError('INVALID_INPUT', 'Impact subject kind is invalid.')

  const collections = [snapshot.entities, snapshot.aliases, snapshot.externalIds, snapshot.sources, snapshot.sourceVersions, snapshot.claims, snapshot.claimEntityLinks, snapshot.evidence, snapshot.contentLinks, snapshot.contentAnchors]
  for (const rows of collections) {
    if (!Array.isArray(rows) || rows.length > KNOWLEDGE_IMPACT_MAX_ROWS_PER_COLLECTION) {
      throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Impact snapshot exceeds the bounded row limit.')
    }
    const identities = new Set<number>()
    for (const row of rows) {
      if (row.ownerUserId !== ownerUserId) corrupt()
      if ('id' in row) {
        if (!Number.isSafeInteger(row.id) || row.id < 1 || identities.has(row.id)) corrupt()
        identities.add(row.id)
      }
    }
  }

  if (snapshot.publisher && snapshot.publisher.ownerUserId !== ownerUserId) corrupt()
  if (!Array.isArray(snapshot.adapterCoverage) || snapshot.adapterCoverage.length !== KNOWLEDGE_IMPACT_BUCKET_ORDER.length) corrupt()
  const coverageCategories = new Set<KnowledgeImpactCategory>()
  let registeredDependencyCount = 0
  for (const coverage of snapshot.adapterCoverage) {
    if (!KNOWLEDGE_IMPACT_BUCKET_ORDER.includes(coverage.category) || coverageCategories.has(coverage.category)) corrupt()
    coverageCategories.add(coverage.category)
    if (coverage.state !== 'complete' && coverage.state !== 'unconfigured') corrupt()
    if (typeof coverage.scope !== 'string' || !coverage.scope.trim() || coverage.scope.length > 120 || !Array.isArray(coverage.limitationCodes) || coverage.limitationCodes.length > 16 || coverage.limitationCodes.some((code: unknown) => typeof code !== 'string' || !/^[a-z0-9_]{1,64}$/u.test(code))) corrupt()
    if (!Array.isArray(coverage.consumers) || coverage.consumers.length > KNOWLEDGE_IMPACT_MAX_CONSUMERS_PER_CATEGORY) {
      throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Impact adapter registrations exceed the bounded consumer limit.')
    }
    if (coverage.state === 'complete' && !coverage.scope.trim()) corrupt()
    if (coverage.state === 'unconfigured' && coverage.consumers.length > 0) corrupt()
    if (coverage.category === 'content' || coverage.category === 'schema') {
      if (coverage.state !== 'unconfigured' || coverage.consumers.length !== 0) corrupt()
    } else {
      const consumerVersions = new Set<string>()
      for (const consumer of coverage.consumers) {
        validateConsumer(ownerUserId, coverage.category, consumer)
        registeredDependencyCount += consumer.dependencies.length
        if (registeredDependencyCount > KNOWLEDGE_IMPACT_MAX_REFERENCES) overExpansionBudget()
      }
      for (const consumer of coverage.consumers) {
        const key = `${consumer.consumerId}:${consumer.version}`
        if (consumerVersions.has(key)) corrupt()
        consumerVersions.add(key)
      }
    }
  }
  if (coverageCategories.size !== KNOWLEDGE_IMPACT_BUCKET_ORDER.length) corrupt()

  const entities = new Map(snapshot.entities.map(row => [row.id, row]))
  const claims = new Map(snapshot.claims.map(row => [row.id, row]))
  const sources = new Map(snapshot.sources.map(row => [row.id, row]))
  const heads = snapshot.revisionHeads ?? []
  if (Object.hasOwn(snapshot, 'revisionHeads') && !Array.isArray(snapshot.revisionHeads)) corrupt()
  if (heads.length > KNOWLEDGE_IMPACT_MAX_ROWS_PER_COLLECTION) overExpansionBudget()
  const headSubjects = new Set<string>()
  const headKeys = ['ownerUserId', 'subjectKind', 'subjectId', 'revisionNumber', 'contentHash', 'revisionFingerprint']
  for (const head of heads) {
    if (!head || typeof head !== 'object' || Array.isArray(head) || Object.keys(head).length !== headKeys.length || headKeys.some(key => !Object.hasOwn(head, key))) corrupt()
    if (head.ownerUserId !== ownerUserId || !['entity', 'claim', 'source'].includes(head.subjectKind)
      || !Number.isSafeInteger(head.subjectId) || head.subjectId < 1 || head.subjectId > 2_147_483_647
      || !Number.isSafeInteger(head.revisionNumber) || head.revisionNumber < 1 || head.revisionNumber > 2_147_483_647
      || typeof head.contentHash !== 'string' || !SHA256_RE.test(head.contentHash)
      || typeof head.revisionFingerprint !== 'string' || !SHA256_RE.test(head.revisionFingerprint)) corrupt()
    const key = `${head.subjectKind}:${head.subjectId}`
    if (headSubjects.has(key)) corrupt()
    headSubjects.add(key)
    const rows = head.subjectKind === 'entity' ? entities : head.subjectKind === 'claim' ? claims : sources
    if (!rows.has(head.subjectId)) corrupt()
  }
  const versions = new Map(snapshot.sourceVersions.map(row => [row.id, row]))
  const anchorsByDraft = new Map(snapshot.contentAnchors.map(row => [row.draftId, row]))
  const linksSeen = new Set<string>()
  const evidenceSeen = new Set<string>()
  const contentSeen = new Set<string>()
  if (anchorsByDraft.size !== snapshot.contentAnchors.length) corrupt()

  for (const row of snapshot.entities) {
    if (row.mergedIntoEntityId !== null && !entities.has(row.mergedIntoEntityId)) corrupt()
    if ((row.status === 'merged') !== (row.mergedIntoEntityId !== null)) corrupt()
    if (!['active', 'merged', 'retired'].includes(row.status) || !row.entityUid.trim() || !row.canonicalName.trim() || (row.canonicalUriHash !== null && !SHA256_RE.test(row.canonicalUriHash))) corrupt()
    if (!['Person', 'Organization', 'Brand', 'Product', 'Service', 'Concept', 'Topic', 'Location', 'Author', 'Research', 'Dataset', 'Claim', 'Source', 'Article', 'Question', 'Event', 'Statistic'].includes(row.entityType)) corrupt()
    if (!['private', 'public_candidate'].includes(row.publicVisibility) || !validDate(row.createdAt) || !validDate(row.updatedAt)) corrupt()
    const visited = new Set<number>()
    let current: typeof row | undefined = row
    let hops = 0
    while (current?.mergedIntoEntityId !== null && current !== undefined) {
      if (visited.has(current.id) || hops >= 10) corrupt()
      visited.add(current.id)
      current = entities.get(current.mergedIntoEntityId)
      hops += 1
    }
  }
  for (const row of snapshot.aliases) if (!entities.has(row.entityId) || !row.alias.trim() || !row.aliasNormalized.trim() || !validDate(row.createdAt) || !validDate(row.updatedAt)) corrupt()
  for (const row of snapshot.externalIds) if (!entities.has(row.entityId) || !row.idType.trim() || !row.idValue.trim() || !validDate(row.createdAt) || !validDate(row.updatedAt)) corrupt()
  for (const row of snapshot.sources) if (!SHA256_RE.test(row.urlHash) || !['active', 'archived'].includes(row.status) || !validDate(row.createdAt) || !validDate(row.updatedAt)) corrupt()
  for (const row of snapshot.sourceVersions) {
    if (!sources.has(row.sourceId) || !SHA256_RE.test(row.contentHash) || !Number.isSafeInteger(row.versionNumber) || row.versionNumber < 1 || !validDate(row.createdAt) || !validDate(row.updatedAt) || !validDate(row.retrievedAt)) corrupt()
  }
  const sourceVersionNumbers = new Set<string>()
  for (const row of snapshot.sourceVersions) {
    const key = `${row.sourceId}:${row.versionNumber}`
    if (sourceVersionNumbers.has(key)) corrupt()
    sourceVersionNumbers.add(key)
  }
  for (const row of snapshot.claims) if (!['unverified', 'source_backed', 'independently_confirmed', 'first_party_measured', 'disputed', 'expired', 'retracted'].includes(row.status) || !validDate(row.createdAt) || !validDate(row.updatedAt) || (row.validFrom !== null && !validDate(row.validFrom)) || (row.validTo !== null && !validDate(row.validTo))) corrupt()
  for (const row of snapshot.claimEntityLinks) {
    if (!claims.has(row.claimId) || !entities.has(row.entityId)) corrupt()
    const key = `${row.claimId}:${row.entityId}`
    if (linksSeen.has(key)) corrupt()
    linksSeen.add(key)
  }
  for (const row of snapshot.evidence) {
    if (!claims.has(row.claimId) || !versions.has(row.sourceVersionId) || !SHA256_RE.test(row.contentHash) || !SHA256_RE.test(row.locatorHash) || !['supports', 'contradicts', 'contextualizes', 'supersedes'].includes(row.relation)) corrupt()
    const key = `${row.claimId}:${row.sourceVersionId}:${row.relation}:${row.locatorHash}`
    if (evidenceSeen.has(key)) corrupt()
    evidenceSeen.add(key)
  }
  for (const row of snapshot.contentLinks) {
    if (!entities.has(row.entityId) || !anchorsByDraftHasBrief(anchorsByDraft, row.briefId) || !['author', 'about', 'mentions'].includes(row.role)) corrupt()
    const key = `${row.briefId}:${row.entityId}:${row.role}`
    if (contentSeen.has(key)) corrupt()
    contentSeen.add(key)
  }
  if (snapshot.publisher && !entities.has(snapshot.publisher.organizationEntityId)) corrupt()
  for (const anchor of snapshot.contentAnchors) if (!Number.isSafeInteger(anchor.briefId) || anchor.briefId < 1 || !Number.isSafeInteger(anchor.jobId) || anchor.jobId < 1 || !Number.isSafeInteger(anchor.draftId) || anchor.draftId < 1 || !SHA256_RE.test(anchor.contentHash) || !validDate(anchor.draftCreatedAt)) corrupt()

  const subjectRows = subject.kind === 'entity' ? entities : subject.kind === 'claim' ? claims : sources
  if (!subjectRows.has(subject.id)) throw new KnowledgeImpactError('SUBJECT_NOT_FOUND', 'Impact subject does not exist in this owner-scoped snapshot.')
}

function anchorsByBrief(snapshot: KnowledgeImpactSnapshot): Map<number, KnowledgeImpactSnapshot['contentAnchors'][number][]> {
  const result = new Map<number, KnowledgeImpactSnapshot['contentAnchors'][number][]>()
  for (const anchor of snapshot.contentAnchors) {
    const list = result.get(anchor.briefId) ?? []
    list.push(anchor)
    result.set(anchor.briefId, list)
  }
  return result
}

function anchorsByDraftHasBrief(anchors: Map<number, KnowledgeImpactSnapshot['contentAnchors'][number]>, briefId: number): boolean {
  for (const anchor of anchors.values()) if (anchor.briefId === briefId) return true
  return false
}

function validateConsumer(ownerUserId: number, category: KnowledgeImpactCategory, consumer: KnowledgeImpactConsumerRef): void {
  if (consumer.ownerUserId !== ownerUserId || consumer.category !== category || typeof consumer.consumerId !== 'string' || !consumer.consumerId.trim() || consumer.consumerId.length > 160 || typeof consumer.version !== 'string' || !consumer.version.trim() || consumer.version.length > 80 || !SHA256_RE.test(consumer.contentHash) || !Array.isArray(consumer.dependencies) || consumer.dependencies.length > 1_000) corrupt()
  if (Object.hasOwn(consumer, 'nativeAvailability') && consumer.nativeAvailability !== 'missing') corrupt()
  const seen = new Set<string>()
  for (const dependency of consumer.dependencies) {
    if (!['entity', 'claim', 'source', 'source_version', 'content'].includes(dependency.kind) || !Number.isSafeInteger(dependency.id) || dependency.id < 1) corrupt()
    if (dependency.version !== null && typeof dependency.version !== 'string' && (!Number.isSafeInteger(dependency.version) || dependency.version < 1)) corrupt()
    if (typeof dependency.version === 'string' && dependency.version.length > 80) corrupt()
    if (dependency.contentHash !== null && !SHA256_RE.test(dependency.contentHash)) corrupt()
    if (Object.hasOwn(dependency, 'revisionFingerprint') && (
      !['entity', 'claim', 'source'].includes(dependency.kind)
      || typeof dependency.revisionFingerprint !== 'string' || !SHA256_RE.test(dependency.revisionFingerprint)
    )) corrupt()
    const key = `${dependency.kind}:${dependency.id}:${dependency.version ?? ''}:${dependency.contentHash ?? ''}:${dependency.revisionFingerprint ?? ''}`
    if (seen.has(key)) corrupt()
    seen.add(key)
  }
}

function ref(kind: KnowledgeImpactLineageRef['kind'], id: number, relation: string, version: string | number | null = null, contentHash: string | null = null): KnowledgeImpactLineageRef {
  return { kind, id, relation, version, contentHash }
}

function lineKey(item: KnowledgeImpactLineageRef): string {
  return `${item.kind}:${item.id}:${item.relation}:${item.version ?? ''}:${item.contentHash ?? ''}`
}

function uniqueLineage(items: readonly KnowledgeImpactLineageRef[]): KnowledgeImpactLineageRef[] {
  const map = new Map<string, KnowledgeImpactLineageRef>()
  for (const item of items) map.set(lineKey(item), item)
  return [...map.values()].sort((a, b) => lineKey(a).localeCompare(lineKey(b)))
}

function makeNativeItem(kind: 'content' | 'schema', id: number, version: string, contentHash: string | null, reasonCode: KnowledgeImpactItem['reasonCode'], lineage: readonly KnowledgeImpactLineageRef[]): KnowledgeImpactItem {
  const canonicalLineage = uniqueLineage(lineage)
  return {
    kind,
    id: String(id),
    version,
    contentHash,
    dependencyFingerprint: fingerprint({ kind, id, version, contentHash, lineage: canonicalLineage }),
    reasonCode,
    lineage: canonicalLineage,
  }
}

function entityInputFingerprint(entityId: number, snapshot: KnowledgeImpactSnapshot): string {
  const entity = snapshot.entities.find(item => item.id === entityId)
  if (!entity) return corrupt()
  return fingerprint({
    id: entity.id, entityUid: entity.entityUid, entityType: entity.entityType,
    canonicalNameHash: sha256(entity.canonicalName), summaryHash: entity.summary === null ? null : sha256(entity.summary),
    canonicalUriHash: entity.canonicalUriHash, locale: entity.locale, publicVisibility: entity.publicVisibility,
    status: entity.status, mergedIntoEntityId: entity.mergedIntoEntityId,
    aliases: snapshot.aliases.filter(item => item.entityId === entityId).map(item => ({ id: item.id, aliasHash: sha256(item.alias), locale: item.locale })).sort(byId),
    externalIds: snapshot.externalIds.filter(item => item.entityId === entityId).map(item => ({ id: item.id, idType: item.idType, valueHash: sha256(item.idValue) })).sort(byId),
  })
}

function schemaAnchorFingerprint(anchor: KnowledgeImpactSnapshot['contentAnchors'][number]): string {
  return fingerprint({ briefId: anchor.briefId, draftId: anchor.draftId, titleHash: sha256(anchor.title), language: anchor.language, contentType: anchor.contentType, contentHash: anchor.contentHash, draftCreatedAt: anchor.draftCreatedAt.toISOString() })
}

function schemaEntityInputFingerprint(entity: KnowledgeImpactSnapshot['entities'][number], snapshot: KnowledgeImpactSnapshot): string {
  const publicHttps = (value: string | null): string | null => {
    if (value === null) return null
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
      return parsed.href
    } catch {
      return null
    }
  }
  const url = publicHttps(entity.canonicalUri)
  const sameAs = [...new Set(snapshot.externalIds.filter(item => item.entityId === entity.id).map(item => publicHttps(item.idValue)).filter((value): value is string => value !== null && value !== url))].sort()
  return fingerprint({ id: entity.id, entityUid: entity.entityUid, entityType: entity.entityType, nameHash: sha256(entity.canonicalName), urlHash: url === null ? null : sha256(url), sameAsHashes: sameAs.map(value => sha256(value)) })
}

function getAdapterCoverage(snapshot: KnowledgeImpactSnapshot, category: KnowledgeImpactCategory): KnowledgeImpactAdapterCoverage {
  const found = snapshot.adapterCoverage.find(item => item.category === category)
  if (!found) return corrupt()
  return found
}

function targetDependencies(subject: KnowledgeImpactSubject, snapshot: KnowledgeImpactSnapshot): Map<string, KnowledgeImpactLineageRef[]> {
  const result = new Map<string, KnowledgeImpactLineageRef[]>()
  const add = (kind: KnowledgeImpactDependencyRef['kind'], id: number, version: string | number | null, contentHash: string | null, lineage: KnowledgeImpactLineageRef[]) => {
    const key = `${kind}:${id}:${version ?? ''}:${contentHash ?? ''}`
    result.set(key, uniqueLineage([...(result.get(key) ?? []), ...lineage]))
  }
  const entities = new Map(snapshot.entities.map(item => [item.id, item]))
  const versions = new Map(snapshot.sourceVersions.map(item => [item.id, item]))

  if (subject.kind === 'entity') {
    const root = canonicalEntityId(subject.id, entities)
    const relatedEntityIds = new Set<number>([root])
    for (const entity of snapshot.entities) if (canonicalEntityId(entity.id, entities) === root) relatedEntityIds.add(entity.id)
    for (const entityId of relatedEntityIds) {
      const path = entityRedirectLineage(entityId, entities)
      add('entity', entityId, null, null, path)
    }
    const anchorByBrief = anchorsByBrief(snapshot)
    for (const link of snapshot.contentLinks.filter(item => relatedEntityIds.has(item.entityId))) {
      for (const anchor of anchorByBrief.get(link.briefId) ?? []) {
        add('content', anchor.draftId, String(anchor.draftId), anchor.contentHash, [
          ...entityRedirectLineage(link.entityId, entities),
          ref('content', anchor.draftId, `explicit_content_entity_${link.role}`, String(anchor.draftId), anchor.contentHash),
        ])
      }
    }
    for (const link of snapshot.claimEntityLinks) if (relatedEntityIds.has(link.entityId)) {
      add('claim', link.claimId, null, null, [...entityRedirectLineage(link.entityId, entities), ref('entity', link.entityId, 'claim_entity_link'), ref('claim', link.claimId, 'entity_link_target')])
    }
  } else if (subject.kind === 'claim') {
    add('claim', subject.id, null, null, [ref('claim', subject.id, 'subject')])
  } else {
    const sourceVersions = snapshot.sourceVersions.filter(item => item.sourceId === subject.id).sort((a, b) => a.versionNumber - b.versionNumber || a.id - b.id)
    add('source', subject.id, null, null, [ref('source', subject.id, 'subject')])
    for (const version of sourceVersions) {
      const versionRef = ref('source_version', version.id, 'source_version_of', version.versionNumber, version.contentHash)
      add('source_version', version.id, version.versionNumber, version.contentHash, [ref('source', subject.id, 'has_source_version'), versionRef])
      for (const evidence of snapshot.evidence.filter(item => item.sourceVersionId === version.id)) {
        add('claim', evidence.claimId, null, null, [ref('source', subject.id, 'evidenced_by'), versionRef, ref('claim', evidence.claimId, 'evidence_claim'), ref('source_version', version.id, `evidence_${evidence.relation}`, version.versionNumber, version.contentHash)])
      }
    }
  }
  return result
}

function canonicalEntityId(entityId: number, entities: ReadonlyMap<number, KnowledgeImpactSnapshot['entities'][number]>): number {
  let current = entities.get(entityId)
  const visited = new Set<number>()
  let hops = 0
  while (current && current.mergedIntoEntityId !== null) {
    if (visited.has(current.id) || hops >= 10) corrupt()
    visited.add(current.id)
    const next = entities.get(current.mergedIntoEntityId)
    if (!next) corrupt()
    current = next
    hops += 1
  }
  if (!current) corrupt()
  return current.id
}

function entityRedirectLineage(entityId: number, entities: ReadonlyMap<number, KnowledgeImpactSnapshot['entities'][number]>): KnowledgeImpactLineageRef[] {
  const path: KnowledgeImpactLineageRef[] = []
  let current = entities.get(entityId)
  const visited = new Set<number>()
  let hops = 0
  while (current) {
    if (visited.has(current.id) || hops > 10) corrupt()
    visited.add(current.id)
    path.push(ref('entity', current.id, current.id === entityId ? 'subject_or_redirected_entity' : 'canonical_redirect_target'))
    if (current.mergedIntoEntityId === null) break
    const next = entities.get(current.mergedIntoEntityId)
    if (!next) corrupt()
    current = next
    hops += 1
  }
  return path
}

function contentAndSchemaItems(subject: KnowledgeImpactSubject, snapshot: KnowledgeImpactSnapshot): { content: KnowledgeImpactItem[]; schema: KnowledgeImpactItem[] } {
  const content: KnowledgeImpactItem[] = []
  const schema: KnowledgeImpactItem[] = []
  if (subject.kind !== 'entity') return { content, schema }

  const entities = new Map(snapshot.entities.map(item => [item.id, item]))
  const subjectRoot = canonicalEntityId(subject.id, entities)
  const related = new Set(snapshot.entities.filter(item => canonicalEntityId(item.id, entities) === subjectRoot).map(item => item.id))
  const anchorsByBriefId = anchorsByBrief(snapshot)
  const links = snapshot.contentLinks.filter(link => related.has(link.entityId))
  const publisherId = snapshot.publisher?.organizationEntityId
  const publisherAffected = publisherId !== undefined && related.has(publisherId)
  const byDraft = new Map<number, { anchor: KnowledgeImpactSnapshot['contentAnchors'][number]; contentLineage: KnowledgeImpactLineageRef[]; schemaLineage: KnowledgeImpactLineageRef[] }>()

  for (const link of links) {
    const anchors = anchorsByBriefId.get(link.briefId) ?? []
    for (const anchor of anchors) {
      const current = byDraft.get(anchor.draftId) ?? { anchor, contentLineage: [], schemaLineage: [] }
      current.contentLineage.push(...entityRedirectLineage(link.entityId, entities), ref('entity', link.entityId, `content_entity_input_${link.role}`, null, entityInputFingerprint(link.entityId, snapshot)), ref('content', anchor.draftId, `content_entity_${link.role}`, anchor.draftId, anchor.contentHash))
      if (link.role === 'author') {
        const canonical = entities.get(canonicalEntityId(link.entityId, entities))
        const eligibleAuthor = canonical !== undefined && ['Person', 'Author', 'Organization', 'Brand'].includes(canonical.entityType)
        if (eligibleAuthor) {
          const schemaInputHash = schemaEntityInputFingerprint(canonical, snapshot)
          current.schemaLineage.push(...entityRedirectLineage(link.entityId, entities), ref('content', anchor.draftId, 'schema_author_projection_input', anchor.draftId, anchor.contentHash), ref('content', anchor.draftId, 'schema_article_fields_input', null, schemaAnchorFingerprint(anchor)), ref('entity', canonical.id, 'schema_author_input', null, schemaInputHash))
        }
      }
      byDraft.set(anchor.draftId, current)
    }
  }
  if (publisherAffected) {
    for (const anchor of snapshot.contentAnchors) {
      const current = byDraft.get(anchor.draftId) ?? { anchor, contentLineage: [], schemaLineage: [] }
      const canonical = entities.get(canonicalEntityId(publisherId, entities))
      if (canonical && ['Organization', 'Brand'].includes(canonical.entityType)) {
        const schemaInputHash = schemaEntityInputFingerprint(canonical, snapshot)
        current.schemaLineage.push(...entityRedirectLineage(publisherId, entities), ref('content', anchor.draftId, 'schema_publisher_projection_input', anchor.draftId, anchor.contentHash), ref('content', anchor.draftId, 'schema_article_fields_input', null, schemaAnchorFingerprint(anchor)), ref('entity', canonical.id, 'schema_publisher_input', null, schemaInputHash))
      }
      byDraft.set(anchor.draftId, current)
    }
  }

  for (const { anchor, contentLineage, schemaLineage } of byDraft.values()) {
    if (contentLineage.length) content.push(makeNativeItem('content', anchor.draftId, String(anchor.draftId), anchor.contentHash, 'explicit_content_entity_binding', contentLineage))
    if (schemaLineage.length) schema.push(makeNativeItem('schema', anchor.draftId, 'projection-inputs-only', null, 'projection_inputs_only', schemaLineage))
  }
  content.sort(compareItem)
  schema.sort(compareItem)
  return { content, schema }
}

function compareItem(left: KnowledgeImpactItem, right: KnowledgeImpactItem): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
}

function dependencyExists(dependency: KnowledgeImpactDependencyRef, snapshot: KnowledgeImpactSnapshot): boolean {
  switch (dependency.kind) {
    case 'entity': return snapshot.entities.some(row => row.id === dependency.id)
    case 'claim': return snapshot.claims.some(row => row.id === dependency.id)
    case 'source': return snapshot.sources.some(row => row.id === dependency.id)
    case 'source_version': return snapshot.sourceVersions.some(row => row.id === dependency.id)
    case 'content': return snapshot.contentAnchors.some(row => row.draftId === dependency.id)
  }
}

function dependencyHasDrift(dependency: KnowledgeImpactDependencyRef, snapshot: KnowledgeImpactSnapshot): boolean {
  if (dependency.kind === 'source_version') {
    const current = snapshot.sourceVersions.find(row => row.id === dependency.id)
    return !current || (dependency.version !== null && String(current.versionNumber) !== String(dependency.version)) || (dependency.contentHash !== null && current.contentHash !== dependency.contentHash)
  }
  if (dependency.kind === 'content') {
    const current = snapshot.contentAnchors.find(row => row.draftId === dependency.id)
    return !current || (dependency.version !== null && String(current.draftId) !== String(dependency.version)) || (dependency.contentHash !== null && current.contentHash !== dependency.contentHash)
  }
  const pinned = dependency.version !== null || dependency.contentHash !== null || dependency.revisionFingerprint !== undefined
  if (!pinned) return false
  const current = snapshot.revisionHeads?.find(row => row.subjectKind === dependency.kind && row.subjectId === dependency.id)
  return !current
    || (dependency.version !== null && String(current.revisionNumber) !== String(dependency.version))
    || (dependency.contentHash !== null && current.contentHash !== dependency.contentHash)
    || (dependency.revisionFingerprint !== undefined && current.revisionFingerprint !== dependency.revisionFingerprint)
}

function registeredItems(category: KnowledgeImpactCategory, coverage: KnowledgeImpactAdapterCoverage, targets: Map<string, KnowledgeImpactLineageRef[]>, snapshot: KnowledgeImpactSnapshot): { items: KnowledgeImpactItem[]; limitationCodes: string[] } {
  if (category === 'content' || category === 'schema' || coverage.state === 'unconfigured') return { items: [], limitationCodes: [...coverage.limitationCodes] }
  const items: KnowledgeImpactItem[] = []
  let hasDrift = false
  for (const consumer of coverage.consumers) {
    const matched: KnowledgeImpactLineageRef[] = []
    let stale = consumer.nativeAvailability === 'missing'
    for (const dependency of consumer.dependencies) {
      if (!dependencyExists(dependency, snapshot)) corrupt()
      const dependencyDrift = dependencyHasDrift(dependency, snapshot)
      if (dependencyDrift && dependency.kind === 'source_version') corrupt()
      stale ||= dependencyDrift
      const key = `${dependency.kind}:${dependency.id}:${dependency.version ?? ''}:${dependency.contentHash ?? ''}`
      const direct = targets.get(key)
      let matchedDependency = false
      if (direct) {
        matched.push(...direct, ref(dependency.kind, dependency.id, 'registered_consumer_dependency_expected', dependency.version, dependency.contentHash))
        matchedDependency = true
      }
      else {
        // Preserve a stale exact-ID registration as impact, with current lineage and its expected pin.
        for (const [targetKey, lineage] of targets) {
          const [kind, id] = targetKey.split(':')
          if (kind === dependency.kind && id === String(dependency.id)) {
            matched.push(...lineage, ref(dependency.kind, dependency.id, dependencyDrift ? 'registered_consumer_dependency_stale' : 'registered_consumer_dependency', dependency.version, dependency.contentHash))
            matchedDependency = true
          }
        }
      }
      if (matchedDependency && dependency.revisionFingerprint !== undefined) {
        matched.push(ref(dependency.kind, dependency.id, 'registered_consumer_revision_pin', dependency.revisionFingerprint, dependency.contentHash))
      }
      if (matchedDependency && ['entity', 'claim', 'source'].includes(dependency.kind)) {
        const head = snapshot.revisionHeads?.find(row => row.subjectKind === dependency.kind && row.subjectId === dependency.id)
        if (head) matched.push(ref(dependency.kind, dependency.id, 'registered_consumer_dependency_current_revision', head.revisionFingerprint, head.contentHash))
      }
    }
    if (!matched.length) continue
    if (stale) hasDrift = true
    const lineage = uniqueLineage(matched)
    items.push({
      kind: 'consumer', id: consumer.consumerId, version: consumer.version, contentHash: consumer.contentHash,
      dependencyFingerprint: fingerprint({ category, consumerId: consumer.consumerId, version: consumer.version, contentHash: consumer.contentHash, ...(consumer.nativeAvailability === undefined ? {} : { nativeAvailability: consumer.nativeAvailability }), lineage }),
      reasonCode: stale ? 'exact_registered_dependency_stale' : 'exact_registered_dependency', lineage,
    })
  }
  return { items: items.sort(compareItem), limitationCodes: [...coverage.limitationCodes, ...(hasDrift ? ['registered_dependency_snapshot_drift'] : [])] }
}

function makeBucket(category: KnowledgeImpactCategory, state: KnowledgeImpactBucket['state'], scope: string, limitationCodes: readonly string[], items: readonly KnowledgeImpactItem[]): KnowledgeImpactBucket {
  if (items.length > KNOWLEDGE_IMPACT_MAX_ITEMS) throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Impact report exceeds the bounded item limit.')
  return { category, state, scope, limitationCodes: [...limitationCodes].sort(), items: [...items] }
}

function snapshotFingerprintMaterial(ownerUserId: number, subject: KnowledgeImpactSubject, snapshot: KnowledgeImpactSnapshot): unknown {
  return {
    ownerUserId,
    subject,
    entities: snapshot.entities.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, entityUid: row.entityUid, entityType: row.entityType, canonicalNameHash: sha256(row.canonicalName), slugHash: row.slug === null ? null : sha256(row.slug), canonicalUriHash: row.canonicalUriHash, locale: row.locale, summaryHash: row.summary === null ? null : sha256(row.summary), status: row.status, publicVisibility: row.publicVisibility, mergedIntoEntityId: row.mergedIntoEntityId, updatedAt: row.updatedAt.toISOString() })).sort(byId),
    aliases: snapshot.aliases.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, entityId: row.entityId, aliasHash: sha256(row.alias), locale: row.locale })).sort(byId),
    externalIds: snapshot.externalIds.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, entityId: row.entityId, idType: row.idType, idValueHash: sha256(row.idValue) })).sort(byId),
    sources: snapshot.sources.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, urlHash: row.urlHash, titleHash: row.title === null ? null : sha256(row.title), sourceClass: row.sourceClass, status: row.status, notesHash: row.notes === null ? null : sha256(row.notes), updatedAt: row.updatedAt.toISOString() })).sort(byId),
    sourceVersions: snapshot.sourceVersions.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, sourceId: row.sourceId, versionNumber: row.versionNumber, contentHash: row.contentHash })).sort(byId),
    claims: snapshot.claims.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, statementHash: sha256(row.statement), claimType: row.claimType, status: row.status, validFrom: row.validFrom?.toISOString() ?? null, validTo: row.validTo?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() })).sort(byId),
    claimEntityLinks: snapshot.claimEntityLinks.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, claimId: row.claimId, entityId: row.entityId })).sort(byId),
    evidence: snapshot.evidence.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, claimId: row.claimId, sourceVersionId: row.sourceVersionId, relation: row.relation, locatorHash: row.locatorHash, contentHash: row.contentHash })).sort(byId),
    contentLinks: snapshot.contentLinks.map(row => ({ id: row.id, ownerUserId: row.ownerUserId, briefId: row.briefId, entityId: row.entityId, role: row.role })).sort(byId),
    publisher: snapshot.publisher ? { ownerUserId: snapshot.publisher.ownerUserId, organizationEntityId: snapshot.publisher.organizationEntityId } : null,
    contentAnchors: snapshot.contentAnchors.map(row => ({ ownerUserId: row.ownerUserId, briefId: row.briefId, jobId: row.jobId, draftId: row.draftId, titleHash: sha256(row.title), language: row.language, contentType: row.contentType, contentHash: row.contentHash, draftCreatedAt: row.draftCreatedAt.toISOString() })).sort((a, b) => a.draftId - b.draftId),
    revisionHeads: [...(snapshot.revisionHeads ?? [])].sort((a, b) => a.subjectKind.localeCompare(b.subjectKind) || a.subjectId - b.subjectId),
    adapterCoverage: snapshot.adapterCoverage.map(row => ({ category: row.category, state: row.state, scope: row.scope, limitationCodes: [...row.limitationCodes].sort(), consumers: row.consumers.map(consumer => ({ category: consumer.category, ownerUserId: consumer.ownerUserId, consumerId: consumer.consumerId, version: consumer.version, contentHash: consumer.contentHash, ...(consumer.nativeAvailability === undefined ? {} : { nativeAvailability: consumer.nativeAvailability }), dependencies: consumer.dependencies.map(dependency => ({ kind: dependency.kind, id: dependency.id, version: dependency.version, contentHash: dependency.contentHash, ...(dependency.revisionFingerprint === undefined ? {} : { revisionFingerprint: dependency.revisionFingerprint }) })).sort(compareDependency) })).sort((a, b) => a.consumerId.localeCompare(b.consumerId) || a.version.localeCompare(b.version)) })).sort((a, b) => KNOWLEDGE_IMPACT_BUCKET_ORDER.indexOf(a.category) - KNOWLEDGE_IMPACT_BUCKET_ORDER.indexOf(b.category)),
  }
}

function byId<T extends { id: number }>(a: T, b: T): number { return a.id - b.id }
function compareDependency(a: KnowledgeImpactDependencyRef, b: KnowledgeImpactDependencyRef): number { return `${a.kind}:${a.id}:${a.version ?? ''}:${a.contentHash ?? ''}:${a.revisionFingerprint ?? ''}`.localeCompare(`${b.kind}:${b.id}:${b.version ?? ''}:${b.contentHash ?? ''}:${b.revisionFingerprint ?? ''}`) }

function redirectLength(entityId: number, entities: ReadonlyMap<number, KnowledgeImpactSnapshot['entities'][number]>): number {
  let current = entities.get(entityId)
  let length = 0
  const visited = new Set<number>()
  while (current) {
    if (visited.has(current.id) || length > 10) corrupt()
    visited.add(current.id)
    length += 1
    if (current.mergedIntoEntityId === null) return length
    current = entities.get(current.mergedIntoEntityId)
  }
  return corrupt()
}

function addExpansionBudget(current: number, count: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || current + count > KNOWLEDGE_IMPACT_MAX_REFERENCES) overExpansionBudget()
  return current + count
}

/** Count exact pre-dedup lineage fan-out before either resolver path allocates expanded references. */
function validateExpansionBudget(subject: KnowledgeImpactSubject, snapshot: KnowledgeImpactSnapshot): void {
  let budget = 0
  if (subject.kind === 'claim') {
    budget = 1
  } else if (subject.kind === 'source') {
    budget = 1
    const versions = snapshot.sourceVersions.filter(item => item.sourceId === subject.id)
    budget = addExpansionBudget(budget, versions.length * 2)
    const versionIds = new Set(versions.map(item => item.id))
    budget = addExpansionBudget(budget, snapshot.evidence.filter(item => versionIds.has(item.sourceVersionId)).length * 4)
  } else {
    const entities = new Map(snapshot.entities.map(item => [item.id, item]))
    const root = canonicalEntityId(subject.id, entities)
    const related = new Set(snapshot.entities.filter(item => canonicalEntityId(item.id, entities) === root).map(item => item.id))
    const redirectLengths = new Map([...related].map(id => [id, redirectLength(id, entities)]))
    for (const length of redirectLengths.values()) budget = addExpansionBudget(budget, length)

    const anchorsByBrief = new Map<number, number>()
    for (const anchor of snapshot.contentAnchors) anchorsByBrief.set(anchor.briefId, (anchorsByBrief.get(anchor.briefId) ?? 0) + 1)
    for (const link of snapshot.contentLinks) {
      const pathLength = redirectLengths.get(link.entityId)
      if (pathLength === undefined) continue
      const anchorCount = anchorsByBrief.get(link.briefId) ?? 0
      // targetDependencies adds path + content ref; native content adds path + entity-input + content refs.
      budget = addExpansionBudget(budget, anchorCount * (pathLength + 1))
      budget = addExpansionBudget(budget, anchorCount * (pathLength + 2))
      const canonical = entities.get(canonicalEntityId(link.entityId, entities))
      if (link.role === 'author' && canonical && ['Person', 'Author', 'Organization', 'Brand'].includes(canonical.entityType)) {
        budget = addExpansionBudget(budget, anchorCount * (pathLength + 3))
      }
    }
    for (const link of snapshot.claimEntityLinks) {
      const pathLength = redirectLengths.get(link.entityId)
      if (pathLength !== undefined) budget = addExpansionBudget(budget, pathLength + 2)
    }
    const publisherId = snapshot.publisher?.organizationEntityId
    if (publisherId !== undefined && related.has(publisherId)) {
      const canonical = entities.get(canonicalEntityId(publisherId, entities))
      if (canonical && ['Organization', 'Brand'].includes(canonical.entityType)) {
        budget = addExpansionBudget(budget, snapshot.contentAnchors.length * (redirectLengths.get(publisherId)! + 3))
      }
    }
  }
  if (budget > KNOWLEDGE_IMPACT_MAX_REFERENCES) overExpansionBudget()
}

export function resolveKnowledgeImpact(ownerUserId: number, subject: KnowledgeImpactSubject, snapshot: KnowledgeImpactSnapshot): KnowledgeImpactReport {
  validateInput(ownerUserId, subject, snapshot)
  validateExpansionBudget(subject, snapshot)

  const graphFingerprint = fingerprint(snapshotFingerprintMaterial(ownerUserId, subject, snapshot))
  const targets = targetDependencies(subject, snapshot)
  const native = contentAndSchemaItems(subject, snapshot)
  const buckets: KnowledgeImpactBucket[] = []
  for (const category of KNOWLEDGE_IMPACT_BUCKET_ORDER) {
    if (category === 'content') {
      buckets.push(makeBucket(category, 'complete', NATIVE_SCOPE, ['scope_excludes_unregistered_content_consumers'], native.content))
    } else if (category === 'schema') {
      buckets.push(makeBucket(category, 'complete', NATIVE_SCOPE, ['projection_output_not_materialized', 'scope_excludes_unregistered_schema_consumers'], native.schema))
    } else {
      const coverage = getAdapterCoverage(snapshot, category)
      const result = registeredItems(category, coverage, targets, snapshot)
      buckets.push(makeBucket(category, coverage.state, coverage.scope, result.limitationCodes, result.items))
    }
  }

  const itemCount = buckets.reduce((sum, bucket) => sum + bucket.items.length, 0)
  if (itemCount > KNOWLEDGE_IMPACT_MAX_ITEMS) throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Impact report exceeds the bounded total item limit.')
  const affectedKnowledge = uniqueLineage([...targets.values()].flat())
  if (affectedKnowledge.length > KNOWLEDGE_IMPACT_MAX_REFERENCES) throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Impact report exceeds the bounded lineage reference limit.')
  const base = {
    ownerUserId,
    subject: { ...subject },
    coverageScope: 'known_explicit_dependencies_only' as const,
    exhaustive: false as const,
    graphFingerprint,
    affectedKnowledge,
    buckets: buckets as unknown as KnowledgeImpactReport['buckets'],
    automaticPublication: false as const,
    productionActivation: false as const,
    automaticTrainingAdmission: false as const,
  }
  const outputFingerprint = fingerprint(base)
  const report = { ...base, outputFingerprint }
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_JSON_BYTES) throw new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Impact report exceeds the bounded serialized report limit.')
  return report
}
