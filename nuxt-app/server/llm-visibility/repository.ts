import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../database'
import { llmVisibilityObservations, llmVisibilityProjects, llmVisibilityQueries, llmVisibilityRuns } from '../database/schema'
import type { ObservationInput, ProjectInput, QueryInput } from './contracts'
import { VisibilityContractError, VISIBILITY_LIMITATIONS } from './contracts'
import { prepareProject, createTrackingQuery, buildSummaryProjection, type QueryWorkflowRepository, type VisibilityWorkflowRepository } from './service'
import type { ProviderObservationRunInput } from './contracts'
import { buildVisibilityProbePlan, createConfiguredVisibilityProviderAdapters, createEphemeralVisibilityProbeIdempotencyRegistry, executeAndPersistProviderObservations } from '../llm-visibility-probes'

function requireVisibilityDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'LLM Visibility Monitor 暫時無法連線。' })
  return database
}

export async function createVisibilityProject(ownerUserId: number, input: ProjectInput) {
  const database = requireVisibilityDatabase()
  const prepared = prepareProject(input)
  const result = await database.insert(llmVisibilityProjects).values({ ...prepared, ownerUserId, status: 'active' })
  const id = Number(result[0].insertId)
  return { id, ...prepared, status: 'active' as const }
}

export async function createVisibilityQuery(ownerUserId: number, input: QueryInput) {
  const database = requireVisibilityDatabase()
  const adapter: QueryWorkflowRepository = {
    async getProject(scopedOwnerUserId, projectId) {
      const [row] = await database.select().from(llmVisibilityProjects).where(and(eq(llmVisibilityProjects.id, projectId), eq(llmVisibilityProjects.ownerUserId, scopedOwnerUserId))).limit(1)
      return row ? { ...row, brandAliases: Array.isArray(row.brandAliases) ? row.brandAliases as string[] : [], competitorBrands: Array.isArray(row.competitorBrands) ? row.competitorBrands as string[] : [] } : null
    },
    async findQueryByHash(scopedOwnerUserId, projectId, promptHash) {
      const [row] = await database.select().from(llmVisibilityQueries).where(and(eq(llmVisibilityQueries.ownerUserId, scopedOwnerUserId), eq(llmVisibilityQueries.projectId, projectId), eq(llmVisibilityQueries.promptHash, promptHash))).limit(1)
      return row || null
    },
    async insertQuery(values) {
      const result = await database.insert(llmVisibilityQueries).values(values)
      return { id: Number(result[0].insertId) }
    },
  }
  return createTrackingQuery(adapter, ownerUserId, input)
}

export async function runOwnerProviderObservation(ownerUserId: number, input: ProviderObservationRunInput) {
  const database = requireVisibilityDatabase()
  const [projectRow, queryRows] = await Promise.all([
    database.select().from(llmVisibilityProjects).where(and(eq(llmVisibilityProjects.id, input.projectId), eq(llmVisibilityProjects.ownerUserId, ownerUserId))).limit(1),
    database.select().from(llmVisibilityQueries).where(and(eq(llmVisibilityQueries.ownerUserId, ownerUserId), eq(llmVisibilityQueries.projectId, input.projectId), inArray(llmVisibilityQueries.id, input.queryIds))).limit(100),
  ])
  const project = projectRow[0]
  if (!project || project.status !== 'active') throw new VisibilityContractError(404, '找不到此 owner 的 active LLM visibility project。')
  if (queryRows.length !== new Set(input.queryIds).size || queryRows.some(query => !query.active || query.projectId !== project.id)) throw new VisibilityContractError(422, 'provider observation query scope 必須全部屬於此 active project。')
  const ownerScopeKey = `visibility-owner:${ownerUserId}`
  const planResult = buildVisibilityProbePlan({
    ownerScopeKey,
    project: { projectId: String(project.id), canonicalWebsiteDomain: project.canonicalDomain, brandName: project.brandName, brandAliases: Array.isArray(project.brandAliases) ? project.brandAliases as string[] : [], competitorBrands: Array.isArray(project.competitorBrands) ? project.competitorBrands as string[] : [], locale: project.locale },
    activeQuerySnapshots: queryRows.map(query => ({ queryId: String(query.id), projectId: String(query.projectId), promptText: query.promptText, promptHash: query.promptHash, intent: query.intent, locale: query.locale, active: query.active })),
    providerTargets: input.providerTargets,
    observationWindowKey: input.observationWindowKey,
    maximumProbes: input.maximumProbes,
    engineVersion: 'llm_visibility_probe_engine_v1',
  })
  if (planResult.status !== 'planned') throw new VisibilityContractError(422, `provider observation plan blocked: ${planResult.reasonCodes.join(', ')}`)
  const adapters = createConfiguredVisibilityProviderAdapters(input.providerTargets.map(target => ({ adapterKey: target.adapterKey, provider: target.provider, modelLabel: target.modelLabel })))
  const runtime = await executeAndPersistProviderObservations({ ownerUserId, ownerScopeKey, plan: planResult.plan, adapters, idempotencyRegistry: createEphemeralVisibilityProbeIdempotencyRegistry(), repository: createDrizzleVisibilityWorkflowRepository() })
  return { ownerScopeKey, plan: planResult.plan, runtime }
}

export function createDrizzleVisibilityWorkflowRepository(): VisibilityWorkflowRepository {
  const database = requireVisibilityDatabase()
  return {
    async getProject(ownerUserId, projectId) {
      const [row] = await database.select().from(llmVisibilityProjects).where(and(eq(llmVisibilityProjects.id, projectId), eq(llmVisibilityProjects.ownerUserId, ownerUserId))).limit(1)
      return row ? { ...row, brandAliases: Array.isArray(row.brandAliases) ? row.brandAliases as string[] : [], competitorBrands: Array.isArray(row.competitorBrands) ? row.competitorBrands as string[] : [] } : null
    },
    async getQuery(ownerUserId, queryId) {
      const [row] = await database.select().from(llmVisibilityQueries).where(and(eq(llmVisibilityQueries.id, queryId), eq(llmVisibilityQueries.ownerUserId, ownerUserId))).limit(1)
      return row || null
    },
    async getRun(ownerUserId, runId) {
      const [row] = await database.select().from(llmVisibilityRuns).where(and(eq(llmVisibilityRuns.id, runId), eq(llmVisibilityRuns.ownerUserId, ownerUserId))).limit(1)
      return row || null
    },
    async findRunByFingerprint(ownerUserId, fingerprint) {
      const [row] = await database.select().from(llmVisibilityRuns).where(and(eq(llmVisibilityRuns.ownerUserId, ownerUserId), eq(llmVisibilityRuns.requestFingerprint, fingerprint))).limit(1)
      return row || null
    },
    async hasObservation(runId, queryId) {
      const [row] = await database.select({ id: llmVisibilityObservations.id }).from(llmVisibilityObservations).where(and(eq(llmVisibilityObservations.runId, runId), eq(llmVisibilityObservations.queryId, queryId))).limit(1)
      return Boolean(row)
    },
    async commitObservation(input) {
      try {
        return await database.transaction(async transaction => {
          let runId = input.runId
          if (!runId) {
            const runResult = await transaction.insert(llmVisibilityRuns).values({ ownerUserId: input.ownerUserId, projectId: input.projectId, provider: input.provider, modelLabel: input.modelLabel, observationMode: input.observationMode, status: input.status, observedAt: input.observedAtDate, requestFingerprint: input.requestFingerprint, limitationCode: input.limitationCode })
            runId = Number(runResult[0].insertId)
          }
          const observationResult = await transaction.insert(llmVisibilityObservations).values({ ownerUserId: input.ownerUserId, projectId: input.projectId, runId, queryId: input.queryId, brandMentioned: input.brandMentioned, exactMentionCount: input.exactMentionCount, firstMentionPosition: input.firstMentionPosition, citedDomain: input.citedDomain, citationUrls: input.citationUrls, competitorMentions: input.competitorMentions, boundedExcerpt: input.boundedExcerpt, responseHash: input.responseHash, evidenceLocator: input.evidenceLocator, reviewerNote: input.reviewerNote, verifiedByOwner: input.verifiedByOwner })
          return { runId, observationId: Number(observationResult[0].insertId) }
        })
      } catch (error: any) {
        if (error?.code === 'ER_DUP_ENTRY') throw new VisibilityContractError(409, '重複的 run fingerprint 或 run/query observation。')
        throw error
      }
    },
  }
}

export async function listVisibilityWorkspace(ownerUserId: number) {
  const database = requireVisibilityDatabase()
  const [projects, queries, recent] = await Promise.all([
    database.select().from(llmVisibilityProjects).where(eq(llmVisibilityProjects.ownerUserId, ownerUserId)).orderBy(desc(llmVisibilityProjects.updatedAt)),
    database.select().from(llmVisibilityQueries).where(eq(llmVisibilityQueries.ownerUserId, ownerUserId)).orderBy(desc(llmVisibilityQueries.updatedAt)),
    database.select({ id: llmVisibilityObservations.id, projectId: llmVisibilityObservations.projectId, queryId: llmVisibilityObservations.queryId, runId: llmVisibilityObservations.runId, brandMentioned: llmVisibilityObservations.brandMentioned, exactMentionCount: llmVisibilityObservations.exactMentionCount, firstMentionPosition: llmVisibilityObservations.firstMentionPosition, citedDomain: llmVisibilityObservations.citedDomain, citationUrls: llmVisibilityObservations.citationUrls, competitorMentions: llmVisibilityObservations.competitorMentions, boundedExcerpt: llmVisibilityObservations.boundedExcerpt, evidenceLocator: llmVisibilityObservations.evidenceLocator, reviewerNote: llmVisibilityObservations.reviewerNote, verifiedByOwner: llmVisibilityObservations.verifiedByOwner, createdAt: llmVisibilityObservations.createdAt, provider: llmVisibilityRuns.provider, modelLabel: llmVisibilityRuns.modelLabel, observationMode: llmVisibilityRuns.observationMode, observedAt: llmVisibilityRuns.observedAt, limitationCode: llmVisibilityRuns.limitationCode }).from(llmVisibilityObservations).innerJoin(llmVisibilityRuns, and(eq(llmVisibilityObservations.runId, llmVisibilityRuns.id), eq(llmVisibilityRuns.ownerUserId, ownerUserId))).where(eq(llmVisibilityObservations.ownerUserId, ownerUserId)).orderBy(desc(llmVisibilityRuns.observedAt)).limit(50),
  ])
  return { projects, queries, recentObservations: recent, limitations: VISIBILITY_LIMITATIONS, projection: 'traceable_model_observations_v1' }
}

export async function getVisibilityProjectSummary(ownerUserId: number, projectId: number, now = new Date()) {
  const database = requireVisibilityDatabase()
  const [project] = await database.select().from(llmVisibilityProjects).where(and(eq(llmVisibilityProjects.id, projectId), eq(llmVisibilityProjects.ownerUserId, ownerUserId))).limit(1)
  if (!project) throw new VisibilityContractError(404, '找不到此 owner 的 LLM visibility project。')
  const from = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)
  const [queries, rows] = await Promise.all([
    database.select().from(llmVisibilityQueries).where(and(eq(llmVisibilityQueries.ownerUserId, ownerUserId), eq(llmVisibilityQueries.projectId, project.id))).orderBy(desc(llmVisibilityQueries.createdAt)),
    database.select({ id: llmVisibilityObservations.id, queryId: llmVisibilityObservations.queryId, provider: llmVisibilityRuns.provider, modelLabel: llmVisibilityRuns.modelLabel, observationMode: llmVisibilityRuns.observationMode, observedAt: llmVisibilityRuns.observedAt, brandMentioned: llmVisibilityObservations.brandMentioned, exactMentionCount: llmVisibilityObservations.exactMentionCount, firstMentionPosition: llmVisibilityObservations.firstMentionPosition, citedDomain: llmVisibilityObservations.citedDomain, citationUrls: llmVisibilityObservations.citationUrls, competitorMentions: llmVisibilityObservations.competitorMentions, boundedExcerpt: llmVisibilityObservations.boundedExcerpt, evidenceLocator: llmVisibilityObservations.evidenceLocator, reviewerNote: llmVisibilityObservations.reviewerNote, limitationCode: llmVisibilityRuns.limitationCode }).from(llmVisibilityObservations).innerJoin(llmVisibilityRuns, and(eq(llmVisibilityObservations.runId, llmVisibilityRuns.id), eq(llmVisibilityRuns.ownerUserId, ownerUserId), eq(llmVisibilityRuns.projectId, project.id))).where(and(eq(llmVisibilityObservations.ownerUserId, ownerUserId), eq(llmVisibilityObservations.projectId, project.id), gte(llmVisibilityRuns.observedAt, from), lt(llmVisibilityRuns.observedAt, now))).orderBy(desc(llmVisibilityRuns.observedAt)),
  ])
  const normalizedProject = { ...project, brandAliases: Array.isArray(project.brandAliases) ? project.brandAliases as string[] : [], competitorBrands: Array.isArray(project.competitorBrands) ? project.competitorBrands as string[] : [] }
  const metricQueries = queries.map(query => ({ id: query.id, locale: query.locale, active: query.active }))
  const metricRows = rows.map(row => ({ ...row, citationUrls: Array.isArray(row.citationUrls) ? row.citationUrls as string[] : [], competitorMentions: row.competitorMentions && typeof row.competitorMentions === 'object' && !Array.isArray(row.competitorMentions) ? row.competitorMentions as Record<string, number> : {} }))
  return { ...buildSummaryProjection({ project: normalizedProject, queries: metricQueries, observations: metricRows, recentObservations: metricRows.slice(0, 20), now }), queries }
}
