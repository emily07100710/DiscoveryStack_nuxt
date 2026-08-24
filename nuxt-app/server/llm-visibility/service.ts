import type { ObservationInput, ProjectInput, QueryInput } from './contracts'
import { VISIBILITY_LIMITATIONS, VisibilityContractError } from './contracts'
import { canonicalHostname, canonicalizePublicHttps, citationMatchesDomain, normalizedPromptHash, validateObservationTimestamp } from './guards'
import { countBrandMentions, countCompetitorMentions } from './matching'
import { calculateVisibilityMetrics, type MetricObservation, type MetricQuery } from './metrics'

export type ProjectRecord = ProjectInput & { id: number, ownerUserId: number, canonicalDomain: string, status: 'active' | 'archived', createdAt?: Date | string, updatedAt?: Date | string }
export type QueryRecord = QueryInput & { id: number, ownerUserId: number, promptHash: string, createdAt?: Date | string, updatedAt?: Date | string }
export type RunRecord = { id: number, ownerUserId: number, projectId: number, provider: ObservationInput['provider'], modelLabel: string, observationMode: ObservationInput['observationMode'], status: ObservationInput['status'], observedAt: Date | string, requestFingerprint: string, limitationCode: string, createdAt?: Date | string }

export interface VisibilityWorkflowRepository {
  getProject(ownerUserId: number, projectId: number): Promise<ProjectRecord | null>
  getQuery(ownerUserId: number, queryId: number): Promise<QueryRecord | null>
  getRun(ownerUserId: number, runId: number): Promise<RunRecord | null>
  findRunByFingerprint(ownerUserId: number, fingerprint: string): Promise<RunRecord | null>
  hasObservation(runId: number, queryId: number): Promise<boolean>
  commitObservation(input: ObservationInput & { ownerUserId: number, observedAtDate: Date, citedDomain: string | null }): Promise<{ runId: number, observationId: number }>
}

export function canonicalBrandKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und')
}

function normalizedDisplayName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

function dedupeDisplayNames(values: string[], excludedKeys = new Set<string>()): string[] {
  const seen = new Set(excludedKeys)
  const result: string[] = []
  for (const value of values) {
    const display = normalizedDisplayName(value)
    const key = canonicalBrandKey(display)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(display)
  }
  return result
}

export function prepareProject(input: ProjectInput) {
  const canonical = canonicalizePublicHttps(input.canonicalWebsiteUrl)
  const brandName = normalizedDisplayName(input.brandName.normalize('NFKC'))
  const brandKey = canonicalBrandKey(brandName)
  const aliases = dedupeDisplayNames(input.brandAliases, new Set([brandKey]))
  const brandKeys = new Set([brandKey, ...aliases.map(canonicalBrandKey)])
  const competitors = dedupeDisplayNames(input.competitorBrands)
  const collision = competitors.find(competitor => brandKeys.has(canonicalBrandKey(competitor)))
  if (collision) throw new VisibilityContractError(422, `競品名稱「${collision}」不可與品牌名稱或 alias 相同。`)
  return { ...input, canonicalWebsiteUrl: canonical.url, canonicalDomain: canonical.hostname, brandName, brandAliases: aliases, competitorBrands: competitors }
}

export function prepareQuery(input: QueryInput) {
  const promptText = input.promptText.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  return { ...input, promptText, promptHash: normalizedPromptHash(promptText) }
}

export interface QueryWorkflowRepository {
  getProject(ownerUserId: number, projectId: number): Promise<ProjectRecord | null>
  findQueryByHash(ownerUserId: number, projectId: number, promptHash: string): Promise<QueryRecord | null>
  insertQuery(input: ReturnType<typeof prepareQuery> & { ownerUserId: number }): Promise<{ id: number }>
}

export async function createTrackingQuery(repository: QueryWorkflowRepository, ownerUserId: number, input: QueryInput) {
  const prepared = prepareQuery(input)
  const project = await repository.getProject(ownerUserId, input.projectId)
  if (!project || project.status !== 'active') throw new VisibilityContractError(404, '找不到此 owner 的 active LLM visibility project。')
  if (await repository.findQueryByHash(ownerUserId, project.id, prepared.promptHash)) throw new VisibilityContractError(409, '這個 project 已有相同的 tracking prompt。')
  try { return { ...await repository.insertQuery({ ...prepared, ownerUserId }), ...prepared } } catch (error: any) {
    if (error?.code === 'ER_DUP_ENTRY') throw new VisibilityContractError(409, '這個 project 已有相同的 tracking prompt。')
    throw error
  }
}

export async function importObservationSnapshot(repository: VisibilityWorkflowRepository, ownerUserId: number, input: ObservationInput, now = new Date()) {
  if (input.observationMode !== 'manual_verified') throw new VisibilityContractError(422, 'V1 runtime 只接受 owner manual_verified observation snapshot。')
  const [project, query] = await Promise.all([repository.getProject(ownerUserId, input.projectId), repository.getQuery(ownerUserId, input.queryId)])
  if (!project || project.status !== 'active') throw new VisibilityContractError(404, '找不到此 owner 的 active LLM visibility project。')
  if (!query || query.projectId !== project.id || !query.active) throw new VisibilityContractError(404, '找不到此 owner/project 的 active tracking query。')
  const observedAtDate = validateObservationTimestamp(input.observedAt, now)
  const citationHostnames = input.citationUrls.map(url => canonicalizePublicHttps(url).hostname)
  const citedDomain = input.citedDomain ? canonicalHostname(input.citedDomain) : null
  if (citedDomain && !citationHostnames.includes(citedDomain)) throw new VisibilityContractError(422, 'citedDomain 必須精確對應至少一個 citation URL hostname。')
  const excerptBrand = countBrandMentions(input.boundedExcerpt, project.brandName, project.brandAliases)
  if (input.brandMentioned !== excerptBrand.mentioned) throw new VisibilityContractError(422, 'bounded excerpt 與 brandMentioned 不一致。')
  if (excerptBrand.exactMentionCount > input.exactMentionCount) throw new VisibilityContractError(422, 'bounded excerpt 的品牌提及次數不可高於整體 exactMentionCount。')
  const excerptCompetitors = countCompetitorMentions(input.boundedExcerpt, project.competitorBrands)
  for (const [competitor, count] of Object.entries(input.competitorMentions)) {
    if (!project.competitorBrands.includes(competitor)) throw new VisibilityContractError(422, `未知的 competitor brand：${competitor}`)
  }
  for (const competitor of project.competitorBrands) if ((excerptCompetitors[competitor] || 0) > (input.competitorMentions[competitor] || 0)) throw new VisibilityContractError(422, `bounded excerpt 的 ${competitor} 提及次數高於結構化計數。`)
  if (input.runId) {
    const run = await repository.getRun(ownerUserId, input.runId)
    if (!run || run.projectId !== project.id) throw new VisibilityContractError(404, '找不到此 owner/project 的 observation run。')
    const sameObservedAt = new Date(run.observedAt).getTime() === observedAtDate.getTime()
    if (run.provider !== input.provider || run.modelLabel !== input.modelLabel || run.observationMode !== input.observationMode || run.status !== 'completed' || !sameObservedAt || run.requestFingerprint !== input.requestFingerprint || run.limitationCode !== input.limitationCode) throw new VisibilityContractError(422, '既有 run 與匯入 snapshot 的 provider、model、mode、status、time、fingerprint 或 limitation 不一致。')
    if (await repository.hasObservation(run.id, query.id)) throw new VisibilityContractError(409, '此 run/query observation 已存在。')
  } else if (await repository.findRunByFingerprint(ownerUserId, input.requestFingerprint)) {
    throw new VisibilityContractError(409, '此 owner 的 request fingerprint 已存在；請使用既有 runId 或更正輸入。')
  }
  return repository.commitObservation({ ...input, ownerUserId, observedAtDate, citedDomain })
}

export function buildSummaryProjection(input: { project: ProjectRecord, queries: MetricQuery[], observations: MetricObservation[], recentObservations: unknown[], now?: Date }) {
  const currentEnd = input.now || new Date()
  const currentStart = new Date(currentEnd.getTime() - 30 * 24 * 60 * 60 * 1000)
  return {
    project: input.project,
    metrics: calculateVisibilityMetrics({ queries: input.queries, observations: input.observations, canonicalDomain: input.project.canonicalDomain, currentStart, currentEnd }),
    recentObservations: input.recentObservations,
    limitations: VISIBILITY_LIMITATIONS,
    projection: 'traceable_model_observations_v1',
    metricBasis: 'manual_verified_v1' as const,
    prohibitedClaims: ['search ranking', 'consumer UI exposure guarantee', 'traffic guarantee', 'conversion guarantee', 'revenue or ROI guarantee'],
  }
}

export function exactProjectCitation(citationUrls: string[], canonicalDomain: string) {
  return citationUrls.some(url => citationMatchesDomain(url, canonicalDomain))
}
