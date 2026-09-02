import { createError } from 'h3'
import { computePrePostResult, classifyMeasurementPhases } from './assessment'
import { resolveInterventionLoopDependencies } from './dependencies'
import type { InterventionLoopDependencies } from './dependencies'
import { evaluateDeploymentFetch, safeDependencyError } from './deployment-check'
import { dateOnly, dayWindow, fingerprint, parseManualDeploymentInput, parseManualMeasurementInput, parseManualRecrawlInput, parseRegisterInterventionInput } from './normalization'
import type { EventCreate, Intervention, InterventionPatch, InterventionStatus, MeasurementCreate, RegisterInterventionInput } from './types'

function notFound(): never { throw createError({ statusCode: 404, statusMessage: '找不到這筆介入紀錄。', data: { code: 'NOT_FOUND' } }) }
function conflict(code: string, message: string): never { throw createError({ statusCode: 409, statusMessage: message, data: { code } }) }
function invalid(code: string, message: string): never { throw createError({ statusCode: 422, statusMessage: message, data: { code } }) }

type Dependencies = Partial<InterventionLoopDependencies>

function event(ownerUserId: number, interventionId: number, eventType: string, fromStatus: string | null, toStatus: string | null, evidence: Record<string, unknown>, occurredAt: Date): EventCreate {
  const evidenceFingerprint = fingerprint({ interventionId, eventType, fromStatus, toStatus, occurredAt, evidence })
  return { ownerUserId, interventionId, eventType, fromStatus, toStatus, evidence, evidenceFingerprint, occurredAt, createdAt: occurredAt, updatedAt: occurredAt }
}

async function owned(ownerUserId: number, id: number, deps: ReturnType<typeof resolveInterventionLoopDependencies>) {
  const row = await deps.repository.getIntervention(ownerUserId, id)
  if (!row) notFound()
  return row
}

function transitionMessage(current: string, requested: string) { return `目前狀態是 ${current}，不能轉換為 ${requested}。` }

async function transition(deps: ReturnType<typeof resolveInterventionLoopDependencies>, row: Intervention, patch: Omit<InterventionPatch, 'updatedAt'>, eventType: string, toStatus: InterventionStatus, evidence: Record<string, unknown>, now: Date) {
  const updated = await deps.repository.transition(row.ownerUserId, row.id, { ...patch, status: toStatus, updatedAt: now }, event(row.ownerUserId, row.id, eventType, row.status, toStatus, evidence, now))
  if (!updated) notFound()
  return updated
}

async function validateLinks(ownerUserId: number, input: RegisterInterventionInput, deps: ReturnType<typeof resolveInterventionLoopDependencies>) {
  const checks = await Promise.all([
    input.briefId ? deps.linkResolver.resolveBrief(ownerUserId, input.briefId) : Promise.resolve({ id: 0 }),
    input.draftId ? deps.linkResolver.resolveDraft(ownerUserId, input.draftId) : Promise.resolve({ id: 0 }),
    input.entryId ? deps.linkResolver.resolveEntry(ownerUserId, input.entryId) : Promise.resolve({ id: 0 }),
  ])
  if (checks.some(value => !value)) invalid('LINK_NOT_FOUND', '指定的 brief、draft 或 entry 不存在，或不屬於目前擁有者。')
}

export async function registerInterventionWithSource(ownerUserId: number, value: unknown, registrationSource: Intervention['registrationSource'], dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies)
  const input = parseRegisterInterventionInput(value)
  const inputFingerprint = fingerprint({ ...input, registrationSource })
  const existing = await deps.repository.findInterventionByIdempotencyKey(ownerUserId, input.idempotencyKey)
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) conflict('IDEMPOTENCY_CONFLICT', '相同 idempotencyKey 已用於不同的介入內容。')
    return { intervention: existing, replayed: true, limitations: ['idempotent_replay'] }
  }
  await validateLinks(ownerUserId, input, deps)
  const now = deps.clock.now()
  const created = await deps.repository.createIntervention({
    ownerUserId,
    targetUrl: input.targetUrl,
    normalizedUrl: input.normalizedUrl,
    urlHash: input.urlHash,
    siteHost: input.siteHost,
    briefId: input.briefId,
    draftId: input.draftId,
    entryId: input.entryId,
    targetId: input.targetId,
    interventionType: input.interventionType,
    changeSummary: input.changeSummary,
    hypothesis: input.hypothesis,
    expectedImpact: input.expectedImpact,
    expectedSnippet: input.expectedSnippet,
    registrationSource,
    status: 'registered',
    baselineContentHash: null,
    baselineHashSource: null,
    baselineCapturedAt: null,
    deployedAt: null,
    deployEvidenceLevel: null,
    deployEvidenceSource: null,
    deployedContentHash: null,
    deploymentNote: null,
    recrawlStatus: 'not_checked',
    recrawlConfirmedAt: null,
    recrawlSource: null,
    recrawlLastCrawlTime: null,
    recrawlNote: null,
    recrawlAutoAttempts: 0,
    recrawlLastAutoAttemptAt: null,
    recrawlAutoFailureCount: 0,
    recrawlAutoFailureDay: null,
    recrawlLastReason: null,
    measuredAt: null,
    assessedAt: null,
    cancelledAt: null,
    lastMetricsPullAt: null,
    lastMetricsPullReason: null,
    experimentId: null,
    experimentGroup: null,
    idempotencyKey: input.idempotencyKey,
    inputFingerprint,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  })
  await deps.repository.appendEvent(event(ownerUserId, created.id, 'registered', null, 'registered', { changeSummaryLength: input.changeSummary.length, interventionType: input.interventionType, briefId: input.briefId, draftId: input.draftId, entryId: input.entryId, targetId: input.targetId, urlHash: input.urlHash, siteHost: input.siteHost, registrationSource }, now))
  const inventory = await deps.baselineProvider.readInventoryHash(ownerUserId, input.urlHash)
  if (!inventory?.contentHash) return { intervention: created, replayed: false, limitations: ['baseline_unknown'] }
  const capturedAt = inventory.lastFetchedAt || now
  const updated = await deps.repository.updateIntervention(ownerUserId, created.id, { baselineContentHash: inventory.contentHash, baselineHashSource: 'site_evidence_inventory', baselineCapturedAt: capturedAt, updatedAt: now })
  if (!updated) notFound()
  await deps.repository.appendEvent(event(ownerUserId, created.id, 'baseline_captured', 'registered', 'registered', { source: 'site_evidence_inventory', contentHash: inventory.contentHash, lastFetchedAt: inventory.lastFetchedAt }, now))
  return { intervention: updated, replayed: false, limitations: [] }
}

export function registerIntervention(ownerUserId: number, value: unknown, dependencies: Dependencies = {}) { return registerInterventionWithSource(ownerUserId, value, 'manual', dependencies) }

export async function checkDeploymentNow(ownerUserId: number, interventionId: number, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies)
  const row = await owned(ownerUserId, interventionId, deps)
  if (row.status !== 'registered') conflict('INVALID_TRANSITION', transitionMessage(row.status, 'deployed'))
  const now = deps.clock.now()
  let fetched: Awaited<ReturnType<typeof deps.pageFetcher>>
  try { fetched = await deps.pageFetcher(row.normalizedUrl) } catch (error) {
    const evidence = { error: safeDependencyError(error) }
    await deps.repository.appendEvent(event(ownerUserId, row.id, 'deployment_check', row.status, row.status, evidence, now))
    return { intervention: row, outcome: 'check_failed' as const, evidence, limitations: ['deployment_check_failed'] }
  }
  const decision = evaluateDeploymentFetch(row, fetched.body)
  const evidence = { finalUrl: fetched.finalUrl, status: fetched.status, contentHash: decision.contentHash, snippetChecked: decision.snippetChecked, snippetFound: decision.snippetFound, redirectHops: fetched.redirectChain.length }
  await deps.repository.appendEvent(event(ownerUserId, row.id, 'deployment_check', row.status, row.status, evidence, now))
  if (decision.snippetFound) {
    const intervention = await transition(deps, row, { deployedAt: now, deployEvidenceLevel: 'strong', deployEvidenceSource: 'expected_snippet', deployedContentHash: decision.contentHash }, 'deployed', 'deployed', evidence, now)
    return { intervention, outcome: 'deployed_strong' as const, evidence, limitations: [] }
  }
  if (decision.changed) {
    const intervention = await transition(deps, row, { deployedAt: now, deployEvidenceLevel: 'weak', deployEvidenceSource: 'fingerprint_change', deployedContentHash: decision.contentHash }, 'deployed', 'deployed', evidence, now)
    return { intervention, outcome: 'deployed_weak' as const, evidence, limitations: ['deployment_weak_evidence'] }
  }
  if (!row.baselineContentHash) {
    const intervention = await deps.repository.updateIntervention(ownerUserId, row.id, { baselineContentHash: decision.contentHash, baselineHashSource: 'live_fetch', baselineCapturedAt: now, updatedAt: now })
    if (!intervention) notFound()
    await deps.repository.appendEvent(event(ownerUserId, row.id, 'baseline_captured', row.status, row.status, { source: 'live_fetch', contentHash: decision.contentHash }, now))
    return { intervention, outcome: 'baseline_captured' as const, evidence, limitations: [] }
  }
  return { intervention: row, outcome: 'no_change_detected' as const, evidence, limitations: [] }
}

export async function syncDeploymentFromSiteEvidence(ownerUserId: number, interventionId: number, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies)
  const row = await owned(ownerUserId, interventionId, deps)
  if (row.status !== 'registered') return { intervention: row, outcome: 'not_registered' as const, limitations: [] }
  const inventory = await deps.baselineProvider.readInventoryHash(ownerUserId, row.urlHash)
  if (!inventory?.contentHash || !inventory.lastFetchedAt) return { intervention: row, outcome: 'no_inventory_evidence' as const, limitations: ['site_evidence_inventory_unknown'] }
  const now = deps.clock.now()
  if (!row.baselineContentHash && inventory.lastFetchedAt <= row.registeredAt) {
    const intervention = await deps.repository.updateIntervention(ownerUserId, row.id, { baselineContentHash: inventory.contentHash, baselineHashSource: 'site_evidence_inventory', baselineCapturedAt: inventory.lastFetchedAt, updatedAt: now })
    if (!intervention) notFound()
    await deps.repository.appendEvent(event(ownerUserId, row.id, 'baseline_captured', row.status, row.status, { source: 'site_evidence_inventory', contentHash: inventory.contentHash, lastFetchedAt: inventory.lastFetchedAt }, now))
    return { intervention, outcome: 'baseline_captured' as const, limitations: [] }
  }
  if (row.baselineContentHash && inventory.lastFetchedAt > row.registeredAt && inventory.contentHash !== row.baselineContentHash) {
    const evidence = { source: 'site_evidence_scan', contentHash: inventory.contentHash, lastFetchedAt: inventory.lastFetchedAt }
    const intervention = await transition(deps, row, { deployedAt: inventory.lastFetchedAt, deployEvidenceLevel: 'weak', deployEvidenceSource: 'site_evidence_scan', deployedContentHash: inventory.contentHash }, 'deployed', 'deployed', evidence, now)
    return { intervention, outcome: 'deployed_weak' as const, limitations: ['deployment_weak_evidence'] }
  }
  return { intervention: row, outcome: 'no_change_detected' as const, limitations: [] }
}

export async function confirmDeploymentManually(ownerUserId: number, interventionId: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const row = await owned(ownerUserId, interventionId, deps)
  if (row.status !== 'registered') conflict('INVALID_TRANSITION', transitionMessage(row.status, 'deployed'))
  const now = deps.clock.now(); const input = parseManualDeploymentInput(value, now); const deployedAt = input.deployedAt || now
  return transition(deps, row, { deployedAt, deployEvidenceLevel: 'strong', deployEvidenceSource: 'manual', deploymentNote: input.note }, 'deployed', 'deployed', { source: 'manual', noteLength: input.note.length, deployedAt }, now)
}

export async function markPublicationInterventionDeployed(ownerUserId: number, interventionId: number, input: { deliveredAt: Date, contentHash: string | null, receiptFingerprint: string }, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const row = await owned(ownerUserId, interventionId, deps)
  if (row.status !== 'registered') return row
  return transition(deps, row, { baselineContentHash: row.baselineContentHash || input.contentHash, baselineHashSource: row.baselineHashSource || (input.contentHash ? 'content_operations' : null), baselineCapturedAt: row.baselineCapturedAt || (input.contentHash ? input.deliveredAt : null), deployedAt: input.deliveredAt, deployEvidenceLevel: 'strong', deployEvidenceSource: 'publication_receipt', deployedContentHash: input.contentHash }, 'deployed', 'deployed', { source: 'publication_receipt', receiptFingerprint: input.receiptFingerprint, contentHash: input.contentHash }, deps.clock.now())
}

export async function checkRecrawl(ownerUserId: number, interventionId: number, dependencies: Dependencies = {}, options: { automatic?: boolean } = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const row = await owned(ownerUserId, interventionId, deps)
  if (!['deployed', 'recrawl_confirmed', 'measured', 'assessed'].includes(row.status) || row.recrawlStatus === 'confirmed') conflict('INVALID_TRANSITION', transitionMessage(row.status, 'recrawl_confirmed'))
  const now = deps.clock.now(); const inspected = await deps.urlInspector({ ownerUserId, pageUrl: row.normalizedUrl, now })
  const automatic = Boolean(options.automatic)
  const answered = inspected.status === 'crawled' || (inspected.status === 'unknown' && inspected.reasonCode === 'never_crawled')
  const failureDay = now.toISOString().slice(0, 10)
  const automaticAnsweredPatch = automatic && answered ? { recrawlAutoAttempts: row.recrawlAutoAttempts + 1, recrawlLastAutoAttemptAt: now, recrawlAutoFailureCount: 0, recrawlAutoFailureDay: null } : {}
  const automaticFailurePatch = automatic && !answered ? { recrawlAutoFailureCount: row.recrawlAutoFailureDay === failureDay ? row.recrawlAutoFailureCount + 1 : 1, recrawlAutoFailureDay: failureDay } : {}
  const evidence: Record<string, unknown> = inspected.status === 'crawled' ? { status: inspected.status, lastCrawlTime: inspected.lastCrawlTime, property: inspected.property, verdict: inspected.verdict || null, automatic: Boolean(options.automatic) } : { status: inspected.status, reasonCode: inspected.reasonCode, detail: inspected.detail || null, automatic: Boolean(options.automatic) }
  await deps.repository.appendEvent(event(ownerUserId, row.id, 'recrawl_check', row.status, row.status, evidence, now))
  if (inspected.status === 'crawled' && row.deployedAt && inspected.lastCrawlTime >= row.deployedAt) {
    const patch = { ...automaticAnsweredPatch, recrawlStatus: 'confirmed' as const, recrawlConfirmedAt: inspected.lastCrawlTime, recrawlSource: 'gsc_url_inspection' as const, recrawlLastCrawlTime: inspected.lastCrawlTime, recrawlLastReason: null }
    const intervention = row.status === 'deployed' ? await transition(deps, row, patch, 'recrawl_confirmed', 'recrawl_confirmed', evidence, now) : await deps.repository.updateIntervention(ownerUserId, row.id, { ...patch, updatedAt: now })
    if (!intervention) notFound()
    return { intervention, outcome: 'confirmed' as const, limitations: [] }
  }
  if (inspected.status === 'crawled') {
    const intervention = await deps.repository.updateIntervention(ownerUserId, row.id, { ...automaticAnsweredPatch, recrawlStatus: 'unknown', recrawlLastCrawlTime: inspected.lastCrawlTime, recrawlLastReason: 'crawled_before_deploy', updatedAt: now })
    if (!intervention) notFound()
    return { intervention, outcome: 'crawled_before_deploy' as const, reasonCode: 'crawled_before_deploy', limitations: ['recrawl_not_after_deployment'] }
  }
  const intervention = await deps.repository.updateIntervention(ownerUserId, row.id, { ...automaticAnsweredPatch, ...automaticFailurePatch, recrawlStatus: 'unknown', recrawlLastReason: inspected.reasonCode, updatedAt: now })
  if (!intervention) notFound()
  return { intervention, outcome: 'unknown' as const, reasonCode: inspected.reasonCode, limitations: [`recrawl_${inspected.reasonCode}`] }
}

export async function confirmRecrawlManually(ownerUserId: number, interventionId: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const row = await owned(ownerUserId, interventionId, deps)
  if (row.status !== 'deployed') conflict('INVALID_TRANSITION', transitionMessage(row.status, 'recrawl_confirmed'))
  const now = deps.clock.now(); const input = parseManualRecrawlInput(value, now); const confirmedAt = input.confirmedAt || now
  return transition(deps, row, { recrawlStatus: 'confirmed', recrawlConfirmedAt: confirmedAt, recrawlSource: 'manual', recrawlNote: input.note }, 'recrawl_confirmed', 'recrawl_confirmed', { source: 'manual', noteLength: input.note.length, confirmedAt }, now)
}

export async function recordManualMeasurement(ownerUserId: number, interventionId: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const intervention = await owned(ownerUserId, interventionId, deps)
  if (intervention.status === 'cancelled') conflict('INVALID_TRANSITION', transitionMessage(intervention.status, 'measurement_recorded'))
  const input = parseManualMeasurementInput(value); const now = deps.clock.now()
  const sourceHash = fingerprint({ source: input.source, origin: 'manual', windowStart: input.windowStart, windowEnd: input.windowEnd, metrics: input.metrics })
  const stored = await deps.repository.upsertMeasurement({ ownerUserId, interventionId, origin: 'manual', source: input.source, windowStart: input.windowStart, windowEnd: input.windowEnd, metrics: input.metrics, sampleSize: input.sampleSize, sourceHash, capturedAt: now, property: null, pullReason: null, note: input.note, createdAt: now, updatedAt: now })
  await deps.repository.appendEvent(event(ownerUserId, interventionId, 'measurement_recorded', intervention.status, intervention.status, { measurementId: stored.row.id, source: input.source, origin: 'manual', sourceHash, replaced: stored.replaced }, now))
  return { measurement: stored.row, replaced: stored.replaced }
}

export async function pullMetrics(ownerUserId: number, interventionId: number, dependencies: Dependencies = {}, options: { reason: 'owner_request' | 'scheduled_tick' }) {
  const deps = resolveInterventionLoopDependencies(dependencies); const intervention = await owned(ownerUserId, interventionId, deps); const now = deps.clock.now()
  if (intervention.status === 'cancelled' || intervention.status === 'assessed') conflict('INVALID_TRANSITION', transitionMessage(intervention.status, 'metrics_pulled'))
  if (intervention.lastMetricsPullAt && now.getTime() - intervention.lastMetricsPullAt.getTime() < 86_400_000) return { outcome: 'capped' as const, rowsUpserted: 0, nextAllowedAt: new Date(intervention.lastMetricsPullAt.getTime() + 86_400_000), limitations: ['metrics_pull_daily_cap'] }
  const anchor = intervention.deployedAt && intervention.deployedAt < intervention.registeredAt ? intervention.deployedAt : intervention.registeredAt
  let start = new Date(anchor.getTime() - 28 * 86_400_000)
  const end = new Date(now.getTime() - 86_400_000)
  if (end.getTime() - start.getTime() > 119 * 86_400_000) start = new Date(end.getTime() - 119 * 86_400_000)
  const startDate = dateOnly(start); const endDate = dateOnly(end)
  const response = await deps.pageMetricsPuller({ ownerUserId, pageUrl: intervention.normalizedUrl, startDate, endDate, now })
  await deps.repository.updateIntervention(ownerUserId, interventionId, { lastMetricsPullAt: now, lastMetricsPullReason: options.reason, updatedAt: now })
  if (response.status === 'unknown') {
    await deps.repository.appendEvent(event(ownerUserId, interventionId, 'metrics_unknown', intervention.status, intervention.status, { reasonCode: response.reasonCode, detail: response.detail || null, startDate, endDate, pullReason: options.reason }, now))
    return { outcome: 'unknown' as const, rowsUpserted: 0, reasonCode: response.reasonCode, limitations: [`metrics_${response.reasonCode}`] }
  }
  let rowsUpserted = 0
  for (const sourceRow of response.rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(sourceRow.date)) continue
    const window = dayWindow(sourceRow.date)
    const metrics = { clicks: sourceRow.clicks, impressions: sourceRow.impressions, ctr: sourceRow.ctr, averagePosition: sourceRow.position }
    const sourceHash = fingerprint({ source: 'google_search_console', origin: 'system_pulled', windowStart: window.windowStart, windowEnd: window.windowEnd, metrics })
    const row: MeasurementCreate = { ownerUserId, interventionId, origin: 'system_pulled', source: 'google_search_console', ...window, metrics, sampleSize: Math.trunc(sourceRow.impressions), sourceHash, capturedAt: now, property: response.property, pullReason: options.reason, note: null, createdAt: now, updatedAt: now }
    await deps.repository.upsertMeasurement(row); rowsUpserted += 1
  }
  await deps.repository.appendEvent(event(ownerUserId, interventionId, 'metrics_pulled', intervention.status, intervention.status, { property: response.property, startDate, endDate, rows: rowsUpserted, pullReason: options.reason }, now))
  return { outcome: 'pulled' as const, rowsUpserted, limitations: [] }
}

export async function measureIntervention(ownerUserId: number, interventionId: number, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const row = await owned(ownerUserId, interventionId, deps)
  if (row.status !== 'recrawl_confirmed') {
    if (row.recrawlStatus !== 'confirmed' && (row.status === 'registered' || row.status === 'deployed')) conflict('RECRAWL_NOT_CONFIRMED', '必須先確認 Google 已重新抓取這一頁，才能開始量測。')
    conflict('INVALID_TRANSITION', transitionMessage(row.status, 'measured'))
  }
  const measurements = await deps.repository.listMeasurements(ownerUserId, interventionId); const phases = classifyMeasurementPhases(row, measurements)
  if (!phases.baseline.length || !phases.followUp.length) {
    const missing = !phases.baseline.length && !phases.followUp.length ? 'baseline 與 follow-up' : !phases.baseline.length ? 'baseline' : 'follow-up'
    conflict('MEASUREMENTS_MISSING', `缺少 ${missing} 量測資料。`)
  }
  const now = deps.clock.now(); const evidence = { baselineRows: phases.baseline.length, followUpRows: phases.followUp.length, excludedRows: phases.excluded.length, baselineN: phases.baseline.reduce((sum, item) => sum + item.sampleSize, 0), followUpN: phases.followUp.reduce((sum, item) => sum + item.sampleSize, 0), origins: [...new Set(measurements.map(item => item.origin))].sort() }
  return transition(deps, row, { measuredAt: now }, 'measured', 'measured', evidence, now)
}

async function ensureAutoExperiment(ownerUserId: number, row: Intervention, deps: ReturnType<typeof resolveInterventionLoopDependencies>) {
  if (row.experimentId) return row
  const now = deps.clock.now(); const key = `auto:intervention:${row.id}`
  let experiment = await deps.repository.findExperimentByIdempotencyKey(ownerUserId, key)
  if (!experiment) experiment = await deps.repository.createExperiment({ ownerUserId, name: `單頁前後比較 #${row.id}`, design: 'pre_post', hypothesis: row.hypothesis, status: 'running', primaryMetric: 'clicks', startedAt: now, concludedAt: null, idempotencyKey: key, createdAt: now, updatedAt: now })
  const attached = await deps.repository.updateIntervention(ownerUserId, row.id, { experimentId: experiment.id, experimentGroup: 'treatment', updatedAt: now })
  if (!attached) notFound()
  await deps.repository.appendEvent(event(ownerUserId, row.id, 'experiment_attached', row.status, row.status, { experimentId: experiment.id, group: 'treatment', automatic: true }, now))
  return attached
}

export async function assessIntervention(ownerUserId: number, interventionId: number, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); let row = await owned(ownerUserId, interventionId, deps)
  if (row.recrawlStatus !== 'confirmed') conflict('RECRAWL_NOT_CONFIRMED', '必須先確認 Google 已重新抓取這一頁，才能開始量測。')
  if (row.status !== 'measured' && row.status !== 'assessed') conflict('INVALID_TRANSITION', transitionMessage(row.status, 'assessed'))
  row = await ensureAutoExperiment(ownerUserId, row, deps)
  const measurements = await deps.repository.listMeasurements(ownerUserId, interventionId)
  const policy = await deps.repository.getPolicy(ownerUserId) || { minimumSampleSize: 30 }
  const now = deps.clock.now(); const computed = computePrePostResult(row, measurements, policy, now)
  const existing = await deps.repository.findResultByFingerprint(ownerUserId, computed.resultFingerprint)
  const result = existing || await deps.repository.createResult({ ownerUserId, experimentId: row.experimentId!, interventionId: row.id, resultKind: computed.resultKind, metric: computed.metric, sampleSizeBaseline: computed.sampleSizeBaseline, sampleSizeFollowUp: computed.sampleSizeFollowUp, effect: computed.effect, signal: computed.signal, limitations: computed.limitations, causalStatement: computed.causalStatement, computedAt: now, resultFingerprint: computed.resultFingerprint, createdAt: now, updatedAt: now })
  let intervention = row
  if (row.status === 'measured') intervention = await transition(deps, row, { assessedAt: now }, 'assessed', 'assessed', { resultId: result.id, resultFingerprint: result.resultFingerprint, sampleSizeBaseline: result.sampleSizeBaseline, sampleSizeFollowUp: result.sampleSizeFollowUp, signal: result.signal }, now)
  else if (!existing) await deps.repository.appendEvent(event(ownerUserId, row.id, 'assessed', row.status, row.status, { resultId: result.id, resultFingerprint: result.resultFingerprint, reassessed: true }, now))
  return { intervention, result, limitations: result.limitations }
}

export async function cancelIntervention(ownerUserId: number, interventionId: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const row = await owned(ownerUserId, interventionId, deps)
  if (row.status === 'assessed' || row.status === 'cancelled') conflict('INVALID_TRANSITION', transitionMessage(row.status, 'cancelled'))
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'note')) invalid('INVALID_INPUT', '取消輸入格式不正確。')
  const note = (value as { note?: unknown }).note
  if (typeof note !== 'string' || note.trim().length < 3 || note.trim().length > 1000) invalid('INVALID_INPUT', 'note 長度必須介於 3 到 1000 個字元。')
  const now = deps.clock.now(); return transition(deps, row, { cancelledAt: now }, 'cancelled', 'cancelled', { noteLength: note.trim().length }, now)
}

export async function getIntervention(ownerUserId: number, interventionId: number, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const intervention = await owned(ownerUserId, interventionId, deps)
  const [events, measurements, results] = await Promise.all([deps.repository.listEvents(ownerUserId, interventionId), deps.repository.listMeasurements(ownerUserId, interventionId), deps.repository.listResultsForIntervention(ownerUserId, interventionId)])
  return { intervention, events, measurements, results }
}

export async function listInterventions(ownerUserId: number, options: { status?: InterventionStatus, limit?: number } = {}, dependencies: Dependencies = {}) {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit || 50)))
  return resolveInterventionLoopDependencies(dependencies).repository.listInterventions(ownerUserId, { status: options.status, limit })
}

export async function linkOutcomeAssessment(ownerUserId: number, input: { entryId: number, targetId: number | null, assessmentFingerprint: string, status: string, baselineSourceHashes?: string[], followUpSourceHashes?: string[] }, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies)
  const rows = await deps.repository.listInterventionsByEntry(ownerUserId, input.entryId, input.targetId)
  const now = deps.clock.now()
  for (const row of rows) await deps.repository.appendEvent(event(ownerUserId, row.id, 'outcome_assessment_linked', row.status, row.status, { assessmentFingerprint: input.assessmentFingerprint, status: input.status, baselineSourceHashes: input.baselineSourceHashes || [], followUpSourceHashes: input.followUpSourceHashes || [] }, now))
  return { linked: rows.length }
}
