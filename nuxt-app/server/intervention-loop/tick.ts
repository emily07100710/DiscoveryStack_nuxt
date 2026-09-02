import { checkRecrawl, markPublicationInterventionDeployed, pullMetrics, registerInterventionWithSource, syncDeploymentFromSiteEvidence } from './service'
import { evaluateRefreshTriggers } from './refresh-queue'
import { resolveInterventionLoopDependencies } from './dependencies'
import type { InterventionLoopDependencies } from './dependencies'

function codeOf(error: unknown) {
  const candidate = error as { data?: { code?: unknown }, code?: unknown }
  if (typeof candidate?.data?.code === 'string') return candidate.data.code.slice(0, 120)
  if (typeof candidate?.code === 'string') return candidate.code.slice(0, 120)
  return 'INTERVENTION_STEP_FAILED'
}

export async function autoRegisterDeliveredPublications(ownerUserId: number, dependencies: Partial<InterventionLoopDependencies> = {}, options: { limit?: number } = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const limit = Math.max(1, Math.min(200, Math.trunc(options.limit || 50)))
  const publications = await deps.deliveredPublications.listDeliveredPublications(ownerUserId, limit)
  const registered: number[] = []; const errors: Array<{ interventionId: number, step: string, code: string }> = []
  for (const publication of publications) {
    const idempotencyKey = `auto:entry:${publication.entryId}:target:${publication.targetId ?? 0}:${publication.receiptFingerprint}`
    try {
      const existing = await deps.repository.findInterventionByIdempotencyKey(ownerUserId, idempotencyKey)
      if (existing) {
        if (existing.status === 'registered') await markPublicationInterventionDeployed(ownerUserId, existing.id, { deliveredAt: publication.deliveredAt, contentHash: publication.contentHash, receiptFingerprint: publication.receiptFingerprint }, deps)
        continue
      }
      const created = await registerInterventionWithSource(ownerUserId, { targetUrl: publication.publicationUrl, changeSummary: publication.changeSummary, interventionType: 'content_update', briefId: publication.briefId ?? undefined, draftId: publication.draftId ?? undefined, entryId: publication.entryId, targetId: publication.targetId ?? undefined, idempotencyKey }, 'content_operations_delivery', deps)
      await markPublicationInterventionDeployed(ownerUserId, created.intervention.id, { deliveredAt: publication.deliveredAt, contentHash: publication.contentHash, receiptFingerprint: publication.receiptFingerprint }, deps)
      registered.push(created.intervention.id)
    } catch (error) { errors.push({ interventionId: 0, step: 'auto_register', code: codeOf(error) }) }
  }
  return { registered, errors }
}

export async function runInterventionLoopTick(ownerUserId: number, dependencies: Partial<InterventionLoopDependencies> = {}, options: { now?: Date, maxInterventions?: number } = {}) {
  const initial = resolveInterventionLoopDependencies(dependencies); const now = options.now || initial.clock.now(); const deps = { ...initial, clock: { now: () => now } }
  const max = Math.max(1, Math.min(200, Math.trunc(options.maxInterventions || 50)))
  const errors: Array<{ interventionId: number, step: string, code: string }> = []
  let autoRegistered = 0; let deploymentsSynced = 0; let metricsPulled = 0; let metricsUnknown = 0; let metricsCapped = 0; let recrawlChecked = 0; let recrawlConfirmed = 0; let refreshEnqueued = 0
  try {
    const registration = await autoRegisterDeliveredPublications(ownerUserId, deps, { limit: max }); autoRegistered = registration.registered.length; errors.push(...registration.errors)
  } catch (error) { errors.push({ interventionId: 0, step: 'auto_register_list', code: codeOf(error) }) }
  let rows = await deps.repository.listInterventions(ownerUserId, { limit: max })
  for (const row of rows.filter(item => item.status === 'registered')) {
    try { const result = await syncDeploymentFromSiteEvidence(ownerUserId, row.id, deps); if (result.outcome === 'deployed_weak') deploymentsSynced += 1 } catch (error) { errors.push({ interventionId: row.id, step: 'sync_deployment', code: codeOf(error) }) }
  }
  rows = await deps.repository.listInterventions(ownerUserId, { limit: max })
  for (const row of rows.filter(item => ['registered', 'deployed', 'recrawl_confirmed', 'measured'].includes(item.status))) {
    try {
      const result = await pullMetrics(ownerUserId, row.id, deps, { reason: 'scheduled_tick' })
      if (result.outcome === 'pulled') metricsPulled += 1
      else if (result.outcome === 'unknown') metricsUnknown += 1
      else metricsCapped += 1
    } catch (error) { errors.push({ interventionId: row.id, step: 'pull_metrics', code: codeOf(error) }) }
  }
  rows = await deps.repository.listInterventions(ownerUserId, { limit: max })
  const recrawlFailureDay = now.toISOString().slice(0, 10)
  for (const row of rows.filter(item => item.status === 'deployed' && item.recrawlStatus !== 'confirmed' && item.recrawlAutoAttempts < 30 && !(item.recrawlAutoFailureDay === recrawlFailureDay && item.recrawlAutoFailureCount >= 3) && (!item.recrawlLastAutoAttemptAt || now.getTime() - item.recrawlLastAutoAttemptAt.getTime() >= 86_400_000))) {
    try {
      const measurements = await deps.repository.listMeasurements(ownerUserId, row.id)
      if (!measurements.length) continue
      const result = await checkRecrawl(ownerUserId, row.id, deps, { automatic: true }); recrawlChecked += 1; if (result.outcome === 'confirmed') recrawlConfirmed += 1
    } catch (error) { errors.push({ interventionId: row.id, step: 'check_recrawl', code: codeOf(error) }) }
  }
  try { const result = await evaluateRefreshTriggers(ownerUserId, deps, { now }); refreshEnqueued = result.enqueued.length } catch (error) { errors.push({ interventionId: 0, step: 'evaluate_refresh', code: codeOf(error) }) }
  return { autoRegistered, deploymentsSynced, metricsPulled, metricsUnknown, metricsCapped, recrawlChecked, recrawlConfirmed, refreshEnqueued, errors, limitations: ['bounded_owner_tick', 'per_intervention_failures_isolated'] }
}

export async function runInterventionLoopTickSafely(ownerUserId: number, dependencies: Partial<InterventionLoopDependencies> = {}) {
  try { return { ok: true as const, result: await runInterventionLoopTick(ownerUserId, dependencies) } } catch (error) { return { ok: false as const, code: codeOf(error) } }
}
