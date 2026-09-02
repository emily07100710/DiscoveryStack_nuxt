import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { requireAuditDatabase } from '../audit/repository'
import { contentOperationCalendarEntries, seoGeoContentBriefs, seoGeoContentDrafts, seoGeoContentJobs, siteEvidenceUrls } from '../database/schema'
import { createSiteEvidenceFetcher } from '../site-evidence/fetcher'
import { inspectPageUrlWithSearchConsole, collectSearchConsolePageMetricsByUrl } from '../measurement-collection/page-metrics'
import { URL_INSPECTION_ADAPTER_VERSION } from '../measurement-collection/adapters/google-url-inspection'
import { resolveCredentialDependencies } from '../measurement-collection/credentials'
import { createMeasurementCollectionRepository } from '../measurement-collection/repository'
import type { FetchLike, GoogleReadOnlyCredentialResolver, MeasurementRepository } from '../measurement-collection/types'
import { createInterventionLoopRepository } from './repository'
import type { InterventionLoopRepository } from './types'
import { createContentOperationsDeliveredPublicationSource } from './content-operations-source'

export interface InterventionClock { now(): Date }
export interface InterventionLinkResolver {
  resolveBrief(ownerUserId: number, briefId: number): Promise<{ id: number } | null>
  resolveDraft(ownerUserId: number, draftId: number): Promise<{ id: number, jobId: number, contentHash: string | null } | null>
  resolveEntry(ownerUserId: number, entryId: number): Promise<{ id: number } | null>
}
export interface InterventionBaselineProvider {
  readInventoryHash(ownerUserId: number, urlHash: string): Promise<{ contentHash: string | null, lastFetchedAt: Date | null } | null>
}
export type InterventionPageFetcher = (url: string) => Promise<{ finalUrl: string, status: number, body: string, contentType: string | null, redirectChain: string[] }>
export type InterventionUrlInspector = (input: { ownerUserId: number, pageUrl: string, now: Date }) => Promise<
  | { status: 'crawled', lastCrawlTime: Date, property: string, verdict?: string | null, raw?: unknown }
  | { status: 'unknown', reasonCode: 'not_configured' | 'no_matching_property' | 'unsupported_page_url' | 'provider_failure' | 'never_crawled' | 'rate_limited', detail?: string }
>
export type InterventionPageMetricsPuller = (input: { ownerUserId: number, pageUrl: string, startDate: string, endDate: string, now: Date }) => Promise<
  | { status: 'succeeded', property: string, rows: Array<{ date: string, clicks: number, impressions: number, ctr: number, position: number }> }
  | { status: 'unknown', reasonCode: 'not_configured' | 'no_matching_property' | 'unsupported_page_url' | 'provider_failure' | 'rate_limited', detail?: string }
>
export interface InterventionDeliveredPublicationSource {
  listDeliveredPublications(ownerUserId: number, limit: number): Promise<Array<{ entryId: number, targetId: number | null, publicationUrl: string, contentHash: string | null, receiptFingerprint: string, deliveredAt: Date, briefId: number | null, draftId: number | null, changeSummary: string }>>
}
export interface InterventionLoopDependencies {
  repository: InterventionLoopRepository
  clock: InterventionClock
  linkResolver: InterventionLinkResolver
  baselineProvider: InterventionBaselineProvider
  pageFetcher: InterventionPageFetcher
  urlInspector: InterventionUrlInspector
  pageMetricsPuller: InterventionPageMetricsPuller
  deliveredPublications: InterventionDeliveredPublicationSource
}

function database() {
  try { return requireAuditDatabase() } catch { throw createError({ statusCode: 503, statusMessage: '介入實驗資料庫目前無法使用。', data: { code: 'DATABASE_UNAVAILABLE' } }) }
}

export function createDrizzleInterventionLinkResolver(): InterventionLinkResolver {
  return {
    async resolveBrief(ownerUserId, briefId) {
      const [row] = await database().select({ id: seoGeoContentBriefs.id }).from(seoGeoContentBriefs).where(and(eq(seoGeoContentBriefs.ownerUserId, ownerUserId), eq(seoGeoContentBriefs.id, briefId))).limit(1)
      return row || null
    },
    async resolveDraft(ownerUserId, draftId) {
      const [row] = await database().select({ id: seoGeoContentDrafts.id, jobId: seoGeoContentDrafts.jobId, contentHash: seoGeoContentDrafts.contentHash }).from(seoGeoContentDrafts).innerJoin(seoGeoContentJobs, eq(seoGeoContentDrafts.jobId, seoGeoContentJobs.id)).where(and(eq(seoGeoContentJobs.ownerUserId, ownerUserId), eq(seoGeoContentDrafts.id, draftId))).limit(1)
      return row ? { ...row, contentHash: row.contentHash || null } : null
    },
    async resolveEntry(ownerUserId, entryId) {
      const [row] = await database().select({ id: contentOperationCalendarEntries.id }).from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.ownerUserId, ownerUserId), eq(contentOperationCalendarEntries.id, entryId))).limit(1)
      return row || null
    },
  }
}

export function createDrizzleInterventionBaselineProvider(): InterventionBaselineProvider {
  return {
    async readInventoryHash(ownerUserId, hash) {
      const [row] = await database().select({ contentHash: siteEvidenceUrls.contentHash, lastFetchedAt: siteEvidenceUrls.lastFetchedAt }).from(siteEvidenceUrls).where(and(eq(siteEvidenceUrls.ownerUserId, ownerUserId), eq(siteEvidenceUrls.urlHash, hash))).limit(1)
      return row || null
    },
  }
}

export function createSafeInterventionPageFetcher(): InterventionPageFetcher {
  const fetcher = createSiteEvidenceFetcher()
  return async url => {
    const result = await fetcher(url, 'page')
    return { finalUrl: result.finalUrl, status: result.status, body: result.body, contentType: result.contentType || null, redirectChain: result.redirectChain.map(hop => hop.url) }
  }
}

export const unavailableUrlInspector: InterventionUrlInspector = async () => ({ status: 'unknown', reasonCode: 'not_configured' })
export const unavailablePageMetricsPuller: InterventionPageMetricsPuller = async () => ({ status: 'unknown', reasonCode: 'not_configured' })

type MeasurementCollectionDependencyOptions = {
  repository?: Pick<MeasurementRepository, 'listConnections'>
  resolver?: GoogleReadOnlyCredentialResolver
  fetcher?: FetchLike
}

export function createMeasurementCollectionUrlInspector(options: MeasurementCollectionDependencyOptions = {}): InterventionUrlInspector {
  return async input => {
    const repository = options.repository || createMeasurementCollectionRepository()
    const resolver = options.resolver || resolveCredentialDependencies().googleCredentialResolver
    const result = await inspectPageUrlWithSearchConsole({ ...input, repository, resolver, fetcher: options.fetcher })
    if (result.status === 'unknown') return { status: 'unknown', reasonCode: result.reasonCode, detail: result.detail }
    return { status: 'crawled', lastCrawlTime: result.lastCrawlTime, property: result.property, verdict: result.verdict, raw: { adapterVersion: URL_INSPECTION_ADAPTER_VERSION, coverageState: result.coverageState, inspectedAt: result.inspectedAt, limitations: result.limitations } }
  }
}

export function createMeasurementCollectionPageMetricsPuller(options: MeasurementCollectionDependencyOptions = {}): InterventionPageMetricsPuller {
  return async input => {
    const repository = options.repository || createMeasurementCollectionRepository()
    const resolver = options.resolver || resolveCredentialDependencies().googleCredentialResolver
    const result = await collectSearchConsolePageMetricsByUrl({ ...input, repository, resolver, fetcher: options.fetcher })
    if (result.status === 'unknown') return { status: 'unknown', reasonCode: result.reasonCode, detail: result.detail }
    return { status: 'succeeded', property: result.property, rows: result.rows }
  }
}

export function createEmptyDeliveredPublicationSource(): InterventionDeliveredPublicationSource {
  return { async listDeliveredPublications() { return [] } }
}

export function resolveInterventionLoopDependencies(overrides: Partial<InterventionLoopDependencies> = {}): InterventionLoopDependencies {
  return {
    repository: overrides.repository || createInterventionLoopRepository(),
    clock: overrides.clock || { now: () => new Date() },
    linkResolver: overrides.linkResolver || createDrizzleInterventionLinkResolver(),
    baselineProvider: overrides.baselineProvider || createDrizzleInterventionBaselineProvider(),
    pageFetcher: overrides.pageFetcher || createSafeInterventionPageFetcher(),
    urlInspector: overrides.urlInspector || createMeasurementCollectionUrlInspector(),
    pageMetricsPuller: overrides.pageMetricsPuller || createMeasurementCollectionPageMetricsPuller(),
    deliveredPublications: overrides.deliveredPublications || createContentOperationsDeliveredPublicationSource(),
  }
}
