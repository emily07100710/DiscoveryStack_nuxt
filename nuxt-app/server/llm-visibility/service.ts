import type { ObservationInput, OwnerManualObservationImport, ProjectInput, QueryInput } from './contracts'
import { VISIBILITY_LIMITATIONS, VisibilityContractError, providerObservationCandidateSchema, type PersistableObservationInput } from './contracts'
import type { ObservationCandidate } from '../llm-visibility-probes/types'
import { canonicalHostname, canonicalizePublicHttps, citationMatchesDomain, normalizedPromptHash, validateObservationTimestamp } from './guards'
import { countBrandMentions, countCompetitorMentions } from './matching'
import { calculateVisibilityMetrics, type MetricObservation, type MetricQuery, type VisibilityCompetitorRegistryEntry } from './metrics'
import { createDefaultCitationHeadFetch, resolveCitationFreshness, type CitationHeadFetchOptions } from './citation-freshness'

export type ProjectRecord = ProjectInput & { id: number, ownerUserId: number, canonicalDomain: string, status: 'active' | 'archived', createdAt?: Date | string, updatedAt?: Date | string }
export type QueryRecord = QueryInput & { id: number, ownerUserId: number, promptHash: string, createdAt?: Date | string, updatedAt?: Date | string }
export type RunRecord = { id: number, ownerUserId: number, projectId: number, provider: ObservationInput['provider'], modelLabel: string, observationMode: ObservationInput['observationMode'], status: ObservationInput['status'], observedAt: Date | string, requestFingerprint: string, limitationCode: string, promptVersionId?: number | null, benchmarkRunId?: number | null, sampleIndex?: number | null, createdAt?: Date | string }

export interface VisibilityWorkflowRepository {
  getProject(ownerUserId: number, projectId: number): Promise<ProjectRecord | null>
  getQuery(ownerUserId: number, queryId: number): Promise<QueryRecord | null>
  getRun(ownerUserId: number, runId: number): Promise<RunRecord | null>
  findRunByFingerprint(ownerUserId: number, fingerprint: string): Promise<RunRecord | null>
  hasObservation(runId: number, queryId: number): Promise<boolean>
  ensurePromptVersion?(query: QueryRecord): Promise<{ id: number, versionNumber: number }>
  commitObservation(input: PersistableObservationInput & { ownerUserId: number, observedAtDate: Date, citedDomain: string | null, promptVersionId?: number, benchmarkRunId?: number, sampleIndex?: number, citationFreshness?: unknown }): Promise<{ runId: number, observationId: number }>
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

export async function importObservationSnapshot(repository: VisibilityWorkflowRepository, ownerUserId: number, input: OwnerManualObservationImport, now = new Date()) {
  const untrusted = input as unknown as Record<string, unknown>
  if ('observationMode' in untrusted || 'status' in untrusted || 'verifiedByOwner' in untrusted) throw new VisibilityContractError(422, 'Manual snapshot authority fields are server-derived and must not appear in import input.')
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
    if (run.provider !== input.provider || run.modelLabel !== input.modelLabel || run.observationMode !== 'manual_verified' || run.status !== 'completed' || !sameObservedAt || run.requestFingerprint !== input.requestFingerprint || run.limitationCode !== input.limitationCode) throw new VisibilityContractError(422, '既有 run 與 pending snapshot 的 provider、model、server mode/status、time、fingerprint 或 limitation 不一致。')
    if (await repository.hasObservation(run.id, query.id)) throw new VisibilityContractError(409, '此 run/query observation 已存在。')
  } else if (await repository.findRunByFingerprint(ownerUserId, input.requestFingerprint)) {
    throw new VisibilityContractError(409, '此 owner 的 request fingerprint 已存在；請使用既有 runId 或更正輸入。')
  }
  const promptVersion = await repository.ensurePromptVersion?.(query)
  const citationFreshness = await resolveCitationFreshness(input.citationUrls, { observedAt: observedAtDate })
  return repository.commitObservation({ ...input, observationMode: 'manual_verified', status: 'completed', verifiedByOwner: false, ownerUserId, observedAtDate, citedDomain, promptVersionId: promptVersion?.id, citationFreshness })
}

export type ProviderObservationPersistenceOptions = { promptVersionId?: number, benchmarkRunId?: number, sampleIndex?: number, headFetch?: CitationHeadFetchOptions }

export async function persistProviderObservationCandidate(repository: VisibilityWorkflowRepository, ownerUserId: number, candidate: Omit<ObservationCandidate, 'projectId' | 'queryId'> & { projectId: string | number, queryId: string | number }, now = new Date(), options: ProviderObservationPersistenceOptions = {}) {
  const parsed = providerObservationCandidateSchema.safeParse({
    ...candidate,
    persistenceStatus: 'persisted_secondary_only',
    reviewerNote: 'Provider API observation; secondary-only evidence. Owner verification is required before manual_verified primary metrics.',
  })
  if (!parsed.success) throw new VisibilityContractError(422, 'Provider observation candidate is malformed or exceeds bounded evidence limits.')
  const input = parsed.data
  const projectId = typeof input.projectId === 'number' ? input.projectId : /^\d{1,12}$/u.test(input.projectId) ? Number(input.projectId) : 0
  const queryId = typeof input.queryId === 'number' ? input.queryId : /^\d{1,12}$/u.test(input.queryId) ? Number(input.queryId) : 0
  if (!Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(queryId) || queryId < 1) throw new VisibilityContractError(422, 'Provider observation project/query identity is not a durable numeric reference.')
  const [project, query] = await Promise.all([repository.getProject(ownerUserId, projectId), repository.getQuery(ownerUserId, queryId)])
  if (!project || project.status !== 'active') throw new VisibilityContractError(404, '找不到此 owner 的 active LLM visibility project。')
  if (!query || query.projectId !== project.id || !query.active) throw new VisibilityContractError(404, '找不到此 owner/project 的 active tracking query。')
  const observedAtDate = validateObservationTimestamp(input.observedAt, now)
  if (input.ownerScopeKey.trim().length === 0 || projectId !== project.id) throw new VisibilityContractError(422, 'Provider observation owner/project scope is invalid.')
  if (await repository.findRunByFingerprint(ownerUserId, input.requestFingerprint)) throw new VisibilityContractError(409, '此 owner 的 provider observation request fingerprint 已存在。')
  const promptVersion = options.promptVersionId ? { id: options.promptVersionId } : await repository.ensurePromptVersion?.(query)
  const citationFreshness = await resolveCitationFreshness(input.citationUrls, { observedAt: observedAtDate, providerDates: input.citationDates, headFetch: options.headFetch || createDefaultCitationHeadFetch() })
  return repository.commitObservation({
    projectId,
    queryId,
    provider: input.provider,
    modelLabel: input.modelLabel,
    observationMode: input.observationMode,
    status: input.status,
    observedAt: input.observedAt,
    requestFingerprint: input.requestFingerprint,
    limitationCode: input.limitationCode,
    brandMentioned: input.brandMentioned,
    exactMentionCount: input.exactMentionCount,
    firstMentionPosition: input.firstMentionPosition,
    citedDomain: input.citedDomain,
    citationUrls: input.citationUrls,
    competitorMentions: input.competitorMentions,
    boundedExcerpt: input.boundedExcerpt,
    responseHash: input.responseHash,
    evidenceLocator: input.evidenceLocator,
    reviewerNote: input.reviewerNote,
    verifiedByOwner: false,
    ownerUserId,
    observedAtDate,
    promptVersionId: promptVersion?.id,
    benchmarkRunId: options.benchmarkRunId,
    sampleIndex: options.sampleIndex,
    citationFreshness,
  })
}

export function buildSummaryProjection(input: { project: ProjectRecord, queries: MetricQuery[], observations: MetricObservation[], recentObservations: unknown[], competitorRegistry?: VisibilityCompetitorRegistryEntry[], now?: Date }) {
  const currentEnd = input.now || new Date()
  const currentStart = new Date(currentEnd.getTime() - 30 * 24 * 60 * 60 * 1000)
  const metrics = calculateVisibilityMetrics({ queries: input.queries, observations: input.observations, canonicalDomain: input.project.canonicalDomain, currentStart, currentEnd, competitorRegistry: input.competitorRegistry })
  return {
    project: input.project,
    metrics,
    recentObservations: input.recentObservations,
    limitations: [...VISIBILITY_LIMITATIONS, ...metrics.current.limitations],
    projection: 'traceable_model_observations_v1',
    metricBasis: 'manual_review_ledger_v1' as const,
    prohibitedClaims: ['search ranking', 'consumer UI exposure guarantee', 'traffic guarantee', 'conversion guarantee', 'revenue or ROI guarantee'],
  }
}

export function exactProjectCitation(citationUrls: string[], canonicalDomain: string) {
  return citationUrls.some(url => citationMatchesDomain(url, canonicalDomain))
}
