import { createError } from 'h3'
import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import { canonicalizePublicHttps, citationMatchesDomain } from '../llm-visibility/guards'
import { getVisibilityProjectSummary, listActiveVisibilityProjectsForDomain } from '../llm-visibility/repository'
import { assertPaidManagedSiteProject, assertSiteSpecEntitlement } from './module-authority'
import { getManagedSiteRepository } from './repository'
import type { ManagedSiteRepository } from './types'

type VisibilityReader = {
  listProjects: typeof listActiveVisibilityProjectsForDomain
  getSummary: typeof getVisibilityProjectSummary
}

const productionReader: VisibilityReader = { listProjects: listActiveVisibilityProjectsForDomain, getSummary: getVisibilityProjectSummary }

type ReviewedObservation = { queryId: number; provider: string; observationMode: string; observedAt: string | Date; brandMentioned: boolean; citationUrls: string[] }
function isReviewedObservation(value: unknown): value is ReviewedObservation {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return Number.isSafeInteger(row.queryId) && typeof row.provider === 'string' && row.observationMode === 'manual_verified'
    && (typeof row.observedAt === 'string' || row.observedAt instanceof Date)
    && typeof row.brandMentioned === 'boolean' && Array.isArray(row.citationUrls) && row.citationUrls.every(url => typeof url === 'string')
}

export function projectCustomerVisibilitySummary(summary: Awaited<ReturnType<typeof getVisibilityProjectSummary>>, domain: string) {
  const current = summary.metrics.current
  const currentStart = Date.parse(summary.metrics.period.currentStart)
  const currentEnd = Date.parse(summary.metrics.period.currentEnd)
  const promptById = new Map(summary.queries.map(query => [query.id, query.promptText]))
  return {
    status: current.status === 'ready' ? 'ready' as const : 'insufficient_data' as const,
    evidenceBasis: 'owner_approved_manual_observations' as const,
    domain,
    period: summary.metrics.period,
    trackedQueries: current.totalQueries,
    observedQueries: current.observedQueries,
    sampleCount: current.n,
    brandMentionRate: current.brandMentionRate,
    citationRate: current.citationRate,
    exactCitationRate: current.exactCitationRate,
    observations: summary.recentObservations
      .filter(isReviewedObservation)
      .filter(row => {
        const observedAt = new Date(row.observedAt).getTime()
        return Number.isFinite(observedAt) && observedAt >= currentStart && observedAt < currentEnd
      })
      .slice(0, 8)
      .map(row => ({
        query: promptById.get(row.queryId) || '已核實問題',
        provider: row.provider,
        observedAt: row.observedAt,
        brandMentioned: row.brandMentioned,
        citationUrls: row.citationUrls.filter(url => citationMatchesDomain(url, domain)).slice(0, 5),
      })),
    limitations: ['只顯示經 owner 核准的人工觀測；API 回應與一般使用者看到的 AI 答案可能不同。', ...current.limitations],
  }
}

export async function getManagedSiteCustomerVisibilityDashboard(
  ownerUserId: number,
  projectId: number,
  managedRepository: ManagedSiteRepository = getManagedSiteRepository(),
  operationsRepository: ContentOperationsRepository = createContentOperationsRepository(),
  visibilityReader: VisibilityReader = productionReader,
) {
  const authority = await assertPaidManagedSiteProject(ownerUserId, projectId, managedRepository)
  assertSiteSpecEntitlement(authority.spec, 'geo_measurement_dashboard')
  const clientId = authority.project.contentOperationClientId
  if (clientId === null) return { status: 'not_configured' as const, message: '尚未連接網站的內容與搜尋觀測。' }
  const client = await operationsRepository.findClient(ownerUserId, clientId)
  if (!client || client.ownerUserId !== ownerUserId || client.status !== 'active') return { status: 'not_configured' as const, message: '網站的內容營運連線尚未啟用。' }
  let domain: string
  try { domain = canonicalizePublicHttps(client.canonicalSiteOrigin).hostname } catch { return { status: 'not_configured' as const, message: '網站正式 HTTPS 網址尚未確認。' } }
  const projects = await visibilityReader.listProjects(ownerUserId, domain)
  if (projects.length === 0) return { status: 'not_configured' as const, message: '尚未為這個網站設定 AI 引用觀測。' }
  if (projects.length !== 1 || projects[0]?.canonicalDomain !== domain) throw createError({ statusCode: 409, message: '這個網站的引用觀測連結尚未確認。' })
  const summary = await visibilityReader.getSummary(ownerUserId, projects[0].id)
  if (summary.project.canonicalDomain !== domain || summary.project.status !== 'active') throw createError({ statusCode: 409, message: '網站與引用觀測的資料範圍不一致。' })
  return projectCustomerVisibilitySummary(summary, domain)
}
