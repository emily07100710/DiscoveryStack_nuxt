import { createError } from 'h3'
import { resolveInterventionLoopDependencies } from './dependencies'
import type { InterventionLoopDependencies } from './dependencies'
import { dateOnly, fingerprint, parseManualRefreshInput, parseQueueStatusInput, parseRefreshPolicyInput } from './normalization'
import { urlHash } from '../site-evidence/normalization'
import { listAllInterventions } from './paging'
import type { EventCreate, Intervention, RefreshQueueItem } from './types'

function notFound(): never { throw createError({ statusCode: 404, statusMessage: '找不到這筆更新佇列項目。', data: { code: 'NOT_FOUND' } }) }
type Dependencies = Partial<InterventionLoopDependencies>
const DEFAULT_POLICY = { regressionDropPercent: 20, minimumSampleSize: 30, staleAfterDays: 90 } as const

function refreshEvent(row: Intervention, queueItem: RefreshQueueItem, now: Date): EventCreate {
  const evidence = { queueItemId: queueItem.id, trigger: queueItem.trigger, reasonRule: queueItem.reasonRule, dedupeKey: queueItem.dedupeKey }
  const evidenceFingerprint = fingerprint({ interventionId: row.id, eventType: 'refresh_enqueued', fromStatus: row.status, toStatus: row.status, occurredAt: now, evidence })
  return { ownerUserId: row.ownerUserId, interventionId: row.id, eventType: 'refresh_enqueued', fromStatus: row.status, toStatus: row.status, evidence, evidenceFingerprint, occurredAt: now, createdAt: now, updatedAt: now }
}

export async function getRefreshPolicy(ownerUserId: number, dependencies: Dependencies = {}) {
  const row = await resolveInterventionLoopDependencies(dependencies).repository.getPolicy(ownerUserId)
  return row ? { ...row, persisted: true as const } : { ...DEFAULT_POLICY, persisted: false as const }
}

export async function updateRefreshPolicy(ownerUserId: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const input = parseRefreshPolicyInput(value)
  return { ...(await deps.repository.upsertPolicy(ownerUserId, input, deps.clock.now())), persisted: true as const }
}

export async function listRefreshQueue(ownerUserId: number, options: { status?: RefreshQueueItem['status'] } = {}, dependencies: Dependencies = {}) {
  return resolveInterventionLoopDependencies(dependencies).repository.listQueue(ownerUserId, options.status)
}

export async function enqueueRefreshManually(ownerUserId: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const input = parseManualRefreshInput(value); const now = deps.clock.now()
  let intervention: Intervention | null = null; let targetUrl = input.targetUrl; let hash: string
  if (input.interventionId) {
    intervention = await deps.repository.getIntervention(ownerUserId, input.interventionId)
    if (!intervention) notFound()
    targetUrl = intervention.normalizedUrl; hash = intervention.urlHash
  } else hash = urlHash(targetUrl!)
  const dedupeKey = `manual:${hash}:${intervention?.id || 0}:${fingerprint(input.note).slice(0, 16)}`
  const existing = await deps.repository.findActiveQueueItemByDedupeKey(ownerUserId, dedupeKey)
  if (existing) return { item: existing, replayed: true, limitations: ['active_duplicate_suppressed'] }
  const item = await deps.repository.createQueueItem({ ownerUserId, interventionId: intervention?.id || null, targetUrl: targetUrl!, urlHash: hash, trigger: 'manual', severity: input.severity, reasonRule: 'manual', reasonText: input.note, reasonEvidence: { noteFingerprint: fingerprint(input.note) }, recommendedAction: '依照擁有者備註檢查並更新內容', status: 'open', dueAt: input.dueAt, resolvedAt: null, dedupeKey, createdAt: now, updatedAt: now })
  if (intervention) await deps.repository.appendEvent(refreshEvent(intervention, item, now))
  return { item, replayed: false, limitations: [] }
}

export async function updateRefreshQueueItem(ownerUserId: number, id: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const existing = await deps.repository.getQueueItem(ownerUserId, id)
  if (!existing) notFound()
  const input = parseQueueStatusInput(value); const now = deps.clock.now()
  const item = await deps.repository.updateQueueItem(ownerUserId, id, { status: input.status, resolvedAt: input.status === 'done' || input.status === 'dismissed' ? now : null, updatedAt: now })
  if (!item) notFound()
  return item
}

type RegressionEffect = { baseline?: { clicksPerDay?: unknown }, followUp?: { clicksPerDay?: unknown }, deltas?: { clicksPerDay?: unknown } }

async function enqueueIfNew(deps: ReturnType<typeof resolveInterventionLoopDependencies>, row: Intervention, input: Omit<Parameters<typeof deps.repository.createQueueItem>[0], 'id' | 'ownerUserId' | 'interventionId' | 'targetUrl' | 'urlHash' | 'status' | 'resolvedAt' | 'createdAt' | 'updatedAt'>, now: Date) {
  const existing = await deps.repository.findActiveQueueItemByDedupeKey(row.ownerUserId, input.dedupeKey)
  if (existing) return { item: null, duplicate: true }
  const item = await deps.repository.createQueueItem({ ownerUserId: row.ownerUserId, interventionId: row.id, targetUrl: row.normalizedUrl, urlHash: row.urlHash, status: 'open', resolvedAt: null, ...input, createdAt: now, updatedAt: now })
  await deps.repository.appendEvent(refreshEvent(row, item, now))
  return { item, duplicate: false }
}

export async function evaluateRefreshTriggers(ownerUserId: number, dependencies: Dependencies = {}, options: { now?: Date } = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const now = options.now || deps.clock.now(); const policy = await getRefreshPolicy(ownerUserId, deps)
  const rows = await listAllInterventions(deps.repository, ownerUserId); const enqueued: RefreshQueueItem[] = []; let skippedDuplicates = 0
  for (const row of rows.filter(item => item.status === 'assessed')) {
    const result = await deps.repository.findLatestResultForIntervention(ownerUserId, row.id)
    if (!result || result.resultKind !== 'pre_post' || result.sampleSizeBaseline < policy.minimumSampleSize || result.sampleSizeFollowUp < policy.minimumSampleSize) continue
    const effect = result.effect as RegressionEffect; const before = effect.baseline?.clicksPerDay; const after = effect.followUp?.clicksPerDay; const delta = effect.deltas?.clicksPerDay
    if (typeof before !== 'number' || typeof after !== 'number' || typeof delta !== 'number' || delta > -policy.regressionDropPercent / 100) continue
    const dropPercent = Math.abs(delta * 100); const severity = dropPercent >= policy.regressionDropPercent * 2 ? 'critical' : 'warning'; const dedupeKey = `regression:${row.urlHash}:${row.id}`
    const reasonText = `量測退步：每日點擊從 ${before.toFixed(1)} 掉到 ${after.toFixed(1)}（−${Math.round(dropPercent)}%），超過門檻 ${policy.regressionDropPercent}%（樣本 前 ${result.sampleSizeBaseline} / 後 ${result.sampleSizeFollowUp}，門檻 ${policy.minimumSampleSize}）`
    const stored = await enqueueIfNew(deps, row, { trigger: 'regression', severity, reasonRule: 'regression_clicks_per_day_drop', reasonText, reasonEvidence: { clicksPerDayBefore: before, clicksPerDayAfter: after, relativeDelta: delta, dropPercent, sampleSizeBaseline: result.sampleSizeBaseline, sampleSizeFollowUp: result.sampleSizeFollowUp, regressionDropPercent: policy.regressionDropPercent, minimumSampleSize: policy.minimumSampleSize }, recommendedAction: '重新檢查這次改動，考慮回復或再優化', dueAt: null, dedupeKey }, now)
    if (stored.item) enqueued.push(stored.item); else skippedDuplicates += 1
  }
  const expiryRows = rows.filter(item => item.status !== 'cancelled' && item.deployedAt)
  for (const row of expiryRows) {
    const dueAt = new Date(row.deployedAt!.getTime() + policy.staleAfterDays * 86_400_000)
    if (dueAt > now) continue
    const newer = expiryRows.some(candidate => candidate.urlHash === row.urlHash && candidate.id !== row.id && candidate.deployedAt && candidate.deployedAt > row.deployedAt!)
    if (newer) continue
    const dedupeKey = `expiry:${row.urlHash}:${row.id}`
    const reasonText = `上線已超過 ${policy.staleAfterDays} 天（上線日 ${dateOnly(row.deployedAt!)}，門檻 ${policy.staleAfterDays} 天），建議檢查內容是否需要更新`
    const stored = await enqueueIfNew(deps, row, { trigger: 'expiry', severity: 'info', reasonRule: 'stale_after_days', reasonText, reasonEvidence: { deployedAt: row.deployedAt!.toISOString(), staleAfterDays: policy.staleAfterDays, dueAt: dueAt.toISOString() }, recommendedAction: '檢查內容時效、來源與搜尋表現後再決定是否更新', dueAt, dedupeKey }, now)
    if (stored.item) enqueued.push(stored.item); else skippedDuplicates += 1
  }
  return { enqueued, evaluated: rows.length, skippedDuplicates, limitations: ['only_manual_regression_and_expiry_triggers'] }
}
