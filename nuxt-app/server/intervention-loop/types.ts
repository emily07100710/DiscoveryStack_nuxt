import type { experimentResults, interventionEvents, interventionExperiments, interventionMeasurements, interventions, refreshPolicies, refreshQueue } from '../database/schema'

export const interventionStatuses = ['registered', 'deployed', 'recrawl_confirmed', 'measured', 'assessed', 'cancelled'] as const
export type InterventionStatus = (typeof interventionStatuses)[number]
export const interventionTypes = ['content_update', 'new_page', 'structured_data', 'internal_linking', 'technical', 'entity_claim', 'other'] as const
export type InterventionType = (typeof interventionTypes)[number]
export const measurementSources = ['google_search_console', 'llm_visibility', 'first_party_analytics', 'lead_conversion'] as const
export type InterventionMeasurementSource = (typeof measurementSources)[number]
export type InterventionSignal = 'positive_signal' | 'negative_signal' | 'no_material_change' | 'mixed_signal' | 'insufficient_data'
export type ExpectedImpact = { metric: 'clicks' | 'impressions' | 'ctr' | 'averagePosition', direction: 'increase' | 'decrease', note?: string }
export type MeasurementMetrics = Partial<Record<'clicks' | 'impressions' | 'ctr' | 'averagePosition', number>>
export type MeasurementAggregates = {
  clicks: number
  impressions: number
  ctr: number
  averagePosition: number | null
  days: number
  clicksPerDay: number
  impressionsPerDay: number
}
export type PrePostEffect = {
  baseline: MeasurementAggregates
  followUp: MeasurementAggregates
  deltas: { clicksPerDay: number | null, impressionsPerDay: number | null, ctrPercentagePoints: number, averagePosition: number | null }
  primaryMetric: 'clicks'
}

type InterventionDbRow = typeof interventions.$inferSelect
export type Intervention = Omit<InterventionDbRow, 'expectedImpact'> & { expectedImpact: ExpectedImpact | null }
type EventDbRow = typeof interventionEvents.$inferSelect
export type InterventionEvent = Omit<EventDbRow, 'evidence'> & { evidence: Record<string, unknown> }
type MeasurementDbRow = typeof interventionMeasurements.$inferSelect
export type InterventionMeasurement = Omit<MeasurementDbRow, 'metrics'> & { metrics: MeasurementMetrics }
export type InterventionExperiment = typeof interventionExperiments.$inferSelect
type ResultDbRow = typeof experimentResults.$inferSelect
export type ExperimentResult = Omit<ResultDbRow, 'effect' | 'limitations'> & { effect: Record<string, unknown>, limitations: string[] }
type QueueDbRow = typeof refreshQueue.$inferSelect
export type RefreshQueueItem = Omit<QueueDbRow, 'reasonEvidence'> & { reasonEvidence: Record<string, unknown> }
export type RefreshPolicy = typeof refreshPolicies.$inferSelect

export type RegisterInterventionInput = {
  targetUrl: string
  normalizedUrl: string
  urlHash: string
  siteHost: string
  changeSummary: string
  interventionType: InterventionType
  hypothesis: string | null
  expectedImpact: ExpectedImpact | null
  expectedSnippet: string | null
  briefId: number | null
  draftId: number | null
  entryId: number | null
  targetId: number | null
  idempotencyKey: string
}
export type ManualMeasurementInput = { source: InterventionMeasurementSource, windowStart: Date, windowEnd: Date, metrics: MeasurementMetrics, sampleSize: number, note: string | null }
export type ManualDeploymentInput = { note: string, deployedAt: Date | null }
export type ManualRecrawlInput = { note: string, confirmedAt: Date | null }
export type ExperimentInput = { name: string, design: 'pre_post' | 'grouped', hypothesis: string | null, primaryMetric: 'clicks' | 'impressions' | 'ctr' | 'averagePosition', idempotencyKey: string }
export type AttachExperimentInput = { interventionId: number, group: 'treatment' | 'control' }
export type RefreshPolicyInput = Partial<Pick<RefreshPolicy, 'regressionDropPercent' | 'minimumSampleSize' | 'staleAfterDays'>>
export type ManualRefreshInput = { interventionId: number | null, targetUrl: string | null, note: string, severity: 'info' | 'warning' | 'critical', dueAt: Date | null }
export type QueueStatusInput = { status: 'open' | 'in_progress' | 'done' | 'dismissed' }

export type InterventionCreate = Omit<Intervention, 'id' | 'createdAt' | 'updatedAt'> & { createdAt: Date, updatedAt: Date }
export type InterventionPatch = Partial<Omit<Intervention, 'id' | 'ownerUserId' | 'createdAt'>> & { updatedAt: Date }
export type EventCreate = Omit<InterventionEvent, 'id' | 'createdAt' | 'updatedAt'> & { createdAt: Date, updatedAt: Date }
export type MeasurementCreate = Omit<InterventionMeasurement, 'id' | 'createdAt' | 'updatedAt'> & { createdAt: Date, updatedAt: Date }
export type ExperimentCreate = Omit<InterventionExperiment, 'id' | 'createdAt' | 'updatedAt'> & { createdAt: Date, updatedAt: Date }
export type ResultCreate = Omit<ExperimentResult, 'id' | 'createdAt' | 'updatedAt'> & { createdAt: Date, updatedAt: Date }
export type QueueCreate = Omit<RefreshQueueItem, 'id' | 'createdAt' | 'updatedAt'> & { createdAt: Date, updatedAt: Date }

export interface InterventionLoopRepository {
  findInterventionByIdempotencyKey(ownerUserId: number, key: string): Promise<Intervention | null>
  createIntervention(input: InterventionCreate): Promise<Intervention>
  getIntervention(ownerUserId: number, id: number): Promise<Intervention | null>
  listInterventions(ownerUserId: number, options?: { status?: InterventionStatus | InterventionStatus[], limit?: number }): Promise<Intervention[]>
  listInterventionsPage(ownerUserId: number, options: { afterId: number, limit: number, status?: InterventionStatus | InterventionStatus[] }): Promise<Intervention[]>
  listInterventionsByUrlHash(ownerUserId: number, urlHash: string): Promise<Intervention[]>
  listInterventionsByEntry(ownerUserId: number, entryId: number, targetId?: number | null): Promise<Intervention[]>
  updateIntervention(ownerUserId: number, id: number, patch: InterventionPatch): Promise<Intervention | null>
  transition(ownerUserId: number, id: number, patch: InterventionPatch, event: EventCreate): Promise<Intervention | null>
  appendEvent(input: EventCreate): Promise<InterventionEvent>
  listEvents(ownerUserId: number, interventionId: number): Promise<InterventionEvent[]>
  upsertMeasurement(input: MeasurementCreate): Promise<{ row: InterventionMeasurement, replaced: boolean }>
  listMeasurements(ownerUserId: number, interventionId: number): Promise<InterventionMeasurement[]>
  findExperimentByIdempotencyKey(ownerUserId: number, key: string): Promise<InterventionExperiment | null>
  createExperiment(input: ExperimentCreate): Promise<InterventionExperiment>
  getExperiment(ownerUserId: number, id: number): Promise<InterventionExperiment | null>
  updateExperiment(ownerUserId: number, id: number, patch: Partial<Omit<InterventionExperiment, 'id' | 'ownerUserId' | 'createdAt'>> & { updatedAt: Date }): Promise<InterventionExperiment | null>
  listExperiments(ownerUserId: number): Promise<InterventionExperiment[]>
  createResult(input: ResultCreate): Promise<ExperimentResult>
  findResultByFingerprint(ownerUserId: number, fingerprint: string): Promise<ExperimentResult | null>
  findLatestResultForIntervention(ownerUserId: number, interventionId: number): Promise<ExperimentResult | null>
  listResultsForIntervention(ownerUserId: number, interventionId: number): Promise<ExperimentResult[]>
  listResultsForExperiment(ownerUserId: number, experimentId: number): Promise<ExperimentResult[]>
  getPolicy(ownerUserId: number): Promise<RefreshPolicy | null>
  upsertPolicy(ownerUserId: number, input: RefreshPolicyInput, now: Date): Promise<RefreshPolicy>
  createQueueItem(input: QueueCreate): Promise<RefreshQueueItem>
  getQueueItem(ownerUserId: number, id: number): Promise<RefreshQueueItem | null>
  updateQueueItem(ownerUserId: number, id: number, patch: Partial<Omit<RefreshQueueItem, 'id' | 'ownerUserId' | 'createdAt'>> & { updatedAt: Date }): Promise<RefreshQueueItem | null>
  listQueue(ownerUserId: number, status?: RefreshQueueItem['status']): Promise<RefreshQueueItem[]>
  findActiveQueueItemByDedupeKey(ownerUserId: number, key: string): Promise<RefreshQueueItem | null>
}
