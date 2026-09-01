import { buildKnowledgeArticleJsonLd } from '../first-party-content-site-kit'
import type { KnowledgeEntityRef } from '../first-party-content-site-kit'
import { DrizzleKnowledgeRepository } from './repository-drizzle'
import { createKnowledgeService } from './service'
import type { KnowledgeContentGap, KnowledgeEntity, KnowledgeRepository } from './types'

export interface ComposeContentStructuredDataInput {
  readonly ownerUserId: number
  readonly briefId?: number
  readonly draftId?: number
  readonly siteOrigin: string
  readonly siteName?: string
  readonly canonicalUrl?: string
}

export interface ContentStructuredDataComposition {
  readonly jsonLd: readonly Readonly<Record<string, unknown>>[]
  readonly gaps: readonly KnowledgeContentGap[]
}

function publicHttps(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

async function entityRef(repository: KnowledgeRepository, ownerUserId: number, entity: KnowledgeEntity, kind: KnowledgeEntityRef['kind']): Promise<KnowledgeEntityRef> {
  const url = publicHttps(entity.canonicalUri)
  const sameAs = [...new Set((await repository.listEntityExternalIds(ownerUserId, entity.id)).map(item => publicHttps(item.idValue)).filter((value): value is string => value !== undefined && value !== url))]
  return {
    entityUid: entity.entityUid,
    name: entity.canonicalName,
    kind,
    ...(url === undefined ? {} : { url }),
    ...(sameAs.length === 0 ? {} : { sameAs }),
  }
}

/** Composes export/preview JSON-LD from real owner-scoped content and knowledge records only. */
export async function composeContentStructuredData(input: ComposeContentStructuredDataInput, repository: KnowledgeRepository = new DrizzleKnowledgeRepository()): Promise<ContentStructuredDataComposition> {
  if ((input.briefId === undefined) === (input.draftId === undefined)) throw new Error('Exactly one of briefId or draftId is required.')
  const anchor = await repository.getContentAnchor({ ownerUserId: input.ownerUserId, briefId: input.briefId, draftId: input.draftId })
  if (!anchor) throw new Error('CONTENT_ANCHOR_NOT_FOUND')
  const service = createKnowledgeService({ ownerUserId: input.ownerUserId, repository })
  const links = await service.listContentEntityLinks({ briefId: anchor.briefId })
  const authorEntities: KnowledgeEntityRef[] = []
  const seenAuthorIds = new Set<number>()
  for (const link of links) {
    if (link.role !== 'author' || seenAuthorIds.has(link.entityId)) continue
    const resolved = await service.resolveEntity(link.entityId)
    if (resolved.status !== 'ok') continue
    const kind = resolved.value.entityType === 'Person' || resolved.value.entityType === 'Author'
      ? 'person'
      : resolved.value.entityType === 'Organization' || resolved.value.entityType === 'Brand'
        ? 'organization'
        : null
    if (kind === null) continue
    seenAuthorIds.add(resolved.value.id)
    authorEntities.push(await entityRef(repository, input.ownerUserId, resolved.value, kind))
  }
  const publisher = await service.getPublisherEntity()
  const publisherEntity = publisher ? await entityRef(repository, input.ownerUserId, publisher, 'organization') : undefined
  const gaps: KnowledgeContentGap[] = []
  if (authorEntities.length === 0) gaps.push({ type: 'missing_author', briefId: anchor.briefId })
  if (publisherEntity === undefined) gaps.push({ type: 'missing_publisher' })
  const siteOrigin = new URL(input.siteOrigin).origin
  const articleId = input.canonicalUrl === undefined ? `${siteOrigin}/#/knowledge/content/${anchor.briefId}` : `${input.canonicalUrl}#article`
  const built = buildKnowledgeArticleJsonLd({
    siteOrigin,
    ...(publisherEntity === undefined ? {} : input.siteName === undefined ? { publisherEntity } : { siteName: input.siteName, publisherEntity }),
    article: {
      headline: anchor.title,
      articleId,
      datePublished: anchor.draftCreatedAt.toISOString(),
      inLanguage: anchor.language,
      ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
    },
    ...(publisherEntity === undefined ? {} : { publisherEntity }),
    ...(authorEntities.length === 0 ? {} : { authorEntities }),
  })
  if (built.status !== 'verified') throw new Error(`${built.code}: ${built.reasons.join(' | ')}`)
  return { jsonLd: [built.jsonLd], gaps }
}
