import type {
  contentOperationMeasurementConnections,
  contentOperationMeasurementRuns,
  contentOperationMeasurementSnapshots,
} from '../database/schema'

export const MEASUREMENT_SOURCES = ['google_search_console', 'first_party_analytics', 'llm_visibility'] as const
export type MeasurementSource = typeof MEASUREMENT_SOURCES[number]

export const MEASUREMENT_CHECKPOINTS = [7, 15, 30, 60, 90] as const
export type MeasurementCheckpointDays = typeof MEASUREMENT_CHECKPOINTS[number]

export const MEASUREMENT_STATES = ['queued', 'processing', 'retry_wait', 'succeeded', 'insufficient_data', 'blocked', 'failed', 'cancelled'] as const
export type MeasurementState = typeof MEASUREMENT_STATES[number]

export const MEASUREMENT_PHASES = ['baseline', 'follow_up'] as const
export type MeasurementPhase = typeof MEASUREMENT_PHASES[number]

export const MEASUREMENT_MAX_RUNS_PER_TICK = 50
export const MEASUREMENT_MAX_PAGE_SCOPE = 100
export const MEASUREMENT_MAX_ERROR_SUMMARY = 240
export const MEASUREMENT_MAX_RESPONSE_BYTES = 2_000_000
export const MEASUREMENT_MAX_ROWS = 1_000
export const MEASUREMENT_MAX_RETRY_ATTEMPTS = 3
export const MEASUREMENT_LEASE_MS = 5 * 60 * 1000
export const MEASUREMENT_RETRY_BASE_MS = 30_000

export type MeasurementConnectionRow = typeof contentOperationMeasurementConnections.$inferSelect
export type MeasurementRunRow = typeof contentOperationMeasurementRuns.$inferSelect
export type MeasurementSnapshotRow = typeof contentOperationMeasurementSnapshots.$inferSelect

export type MeasurementConnectionInput = {
  clientId: number
  publicationTargetId?: number | null
  source: MeasurementSource
  credentialReference?: string | null
  googleSearchConsoleProperty?: string | null
  ga4PropertyId?: string | null
  llmVisibilityProjectId?: number | null
  canonicalOrigin: string
  timeZone: string
  allowedPageScope: string[]
  sourceAvailabilityLagDays?: number
  providerTargets?: unknown[] | null
  idempotencyKey: string
}

export type MeasurementWindow = {
  publicationLocalDate: string
  timeZone: string
  baselineStart: Date
  baselineEnd: Date
  followUpStart: Date
  followUpEnd: Date
  dueAt: Date
}

export type MeasurementSourceSnapshot = {
  source: MeasurementSource
  phase: MeasurementPhase
  deidentifiedSubjectKey: string
  scopeFingerprint: string
  windowStart: string
  windowEnd: string
  capturedAt: string
  sourceHash: string
  normalizedMetrics: Record<string, number>
  providerProvenance: Record<string, unknown>
  limitations: string[]
}

export type GoogleReadOnlyCredential = {
  accessToken: string
  expiresAt: string
  grantedScopes: string[]
}

export type GoogleReadOnlyCredentialResolver = (
  ownerUserId: number,
  credentialReference: string,
  requiredScopes: readonly string[],
) => Promise<GoogleReadOnlyCredential | null>

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type MeasurementAdapterContext = {
  ownerUserId: number
  connection: MeasurementConnectionRow
  run: MeasurementRunRow
  phase: MeasurementPhase
  windowStart: Date
  windowEnd: Date
  canonicalPage: string
  deidentifiedSubjectKey: string
  scopeFingerprint: string
  resolver: GoogleReadOnlyCredentialResolver
  fetcher?: FetchLike
  now?: Date
}

export type AdapterSuccess = {
  status: 'succeeded'
  snapshot: MeasurementSourceSnapshot
}

export type AdapterInsufficientData = {
  status: 'insufficient_data'
  reasonCode: string
  limitations: string[]
}

export type AdapterFailure = {
  status: 'blocked' | 'failed' | 'retry_wait'
  code: string
  summary: string
  retryable: boolean
  limitations: string[]
}

export type MeasurementAdapterResult = AdapterSuccess | AdapterInsufficientData | AdapterFailure

export interface MeasurementSourceAdapter {
  readonly source: MeasurementSource
  collect(context: MeasurementAdapterContext): Promise<MeasurementAdapterResult>
}

export type MeasurementRepository = {
  transaction<T>(work: (repository: MeasurementRepository) => Promise<T>): Promise<T>
  findClient(ownerUserId: number, clientId: number): Promise<{ id: number; ownerUserId: number; canonicalSiteOrigin: string; timeZone: string } | null>
  findConnection(ownerUserId: number, connectionId: number): Promise<MeasurementConnectionRow | null>
  findConnectionByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<MeasurementConnectionRow | null>
  listConnections(ownerUserId: number): Promise<MeasurementConnectionRow[]>
  insertConnection(input: Omit<MeasurementConnectionRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<MeasurementConnectionRow>
  updateConnection(ownerUserId: number, connectionId: number, patch: Partial<Omit<MeasurementConnectionRow, 'id' | 'ownerUserId' | 'createdAt' | 'updatedAt'>>): Promise<MeasurementConnectionRow>
  findRun(ownerUserId: number, runId: number): Promise<MeasurementRunRow | null>
  findRunByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<MeasurementRunRow | null>
  listRuns(ownerUserId: number, filters?: { entryId?: number; clientId?: number }): Promise<MeasurementRunRow[]>
  listEligibleRuns(now: Date, limit: number, ownerUserId?: number): Promise<MeasurementRunRow[]>
  insertRun(input: Omit<MeasurementRunRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<MeasurementRunRow>
  acquireRunLease(ownerUserId: number, runId: number, leaseOwner: string, now: Date, leaseMs: number): Promise<MeasurementRunRow | null>
  releaseRunLease(ownerUserId: number, runId: number, leaseOwner: string, state: MeasurementState, now: Date, patch?: { errorCode?: string | null; errorSummary?: string | null; retryEligibleAt?: Date | null; outputFingerprint?: string | null }): Promise<MeasurementRunRow | null>
  updateRun(ownerUserId: number, runId: number, patch: Partial<Omit<MeasurementRunRow, 'id' | 'ownerUserId' | 'createdAt' | 'updatedAt'>>): Promise<MeasurementRunRow>
  listSnapshots(ownerUserId: number, runId?: number): Promise<MeasurementSnapshotRow[]>
  findSnapshot(ownerUserId: number, runId: number, phase: MeasurementPhase): Promise<MeasurementSnapshotRow | null>
  insertSnapshot(input: Omit<MeasurementSnapshotRow, 'id' | 'createdAt'>): Promise<MeasurementSnapshotRow>
  listLlmScope(ownerUserId: number, projectId: number): Promise<{ project: { id: number; ownerUserId: number; canonicalDomain: string; brandName: string; brandAliases: unknown; competitorBrands: unknown; locale: 'en' | 'zh-hant'; status: 'active' | 'archived' } | null; queries: Array<{ id: number; ownerUserId: number; projectId: number; promptText: string; promptHash: string; intent: string; locale: 'en' | 'zh-hant'; active: boolean }> }>
}

export type MeasurementPublicationLineage = {
  entryId: number
  targetId: number
  clientId: number
  canonicalPage: string
  publicationReceiptFingerprint: string
  contentHash: string
  evidenceSnapshotHash: string
  publicationLocalDate: string
  timeZone: string
  publishedAt: Date
}

export type MeasurementWorkspace = {
  clients: Array<{ id: number; displayName: string; canonicalSiteOrigin: string; timeZone: string }>
  connections: Array<MeasurementConnectionRow & { credentialConfigured: boolean; readiness: 'ready' | 'not_ready' | 'paused' | 'revoked' | 'needs_reauthorization' }>
  runs: MeasurementRunRow[]
  snapshots: MeasurementSnapshotRow[]
  checkpoints: Record<string, { state: MeasurementState | 'not_scheduled'; baselineReady: boolean; followUpReady: boolean; outcomeStatus: 'not_ready' | 'ready' | 'partial' | 'insufficient_data' | 'blocked'; limitations: string[] }>
  capabilities: { schedulerAvailable: true; realGoogleOAuth: boolean; realProviderCalls: false; outcomeCollectionConfigured: true }
  limitations: string[]
}
