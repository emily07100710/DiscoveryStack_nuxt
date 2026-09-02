import { createError } from 'h3'
import { GROUPED_CAUSAL_STATEMENT, latestRelativeClicksDelta } from './assessment'
import { resolveInterventionLoopDependencies } from './dependencies'
import type { InterventionLoopDependencies } from './dependencies'
import { fingerprint, parseAttachExperimentInput, parseExperimentInput } from './normalization'
import { listAllInterventions } from './paging'
import type { EventCreate, ExperimentResult, InterventionSignal } from './types'

function notFound(message = '找不到這筆實驗。'): never { throw createError({ statusCode: 404, statusMessage: message, data: { code: 'NOT_FOUND' } }) }
function conflict(code: string, message: string): never { throw createError({ statusCode: 409, statusMessage: message, data: { code } }) }
type Dependencies = Partial<InterventionLoopDependencies>

function attachedEvent(ownerUserId: number, interventionId: number, status: string, experimentId: number, group: string, now: Date): EventCreate {
  const evidence = { experimentId, group }
  const evidenceFingerprint = fingerprint({ interventionId, eventType: 'experiment_attached', fromStatus: status, toStatus: status, occurredAt: now, evidence })
  return { ownerUserId, interventionId, eventType: 'experiment_attached', fromStatus: status, toStatus: status, evidence, evidenceFingerprint, occurredAt: now, createdAt: now, updatedAt: now }
}

export async function createExperiment(ownerUserId: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const input = parseExperimentInput(value)
  const existing = await deps.repository.findExperimentByIdempotencyKey(ownerUserId, input.idempotencyKey)
  if (existing) {
    if (existing.name !== input.name || existing.design !== input.design || existing.hypothesis !== input.hypothesis || existing.primaryMetric !== input.primaryMetric) conflict('IDEMPOTENCY_CONFLICT', '相同 idempotencyKey 已用於不同的實驗內容。')
    return { experiment: existing, replayed: true, limitations: ['idempotent_replay'] }
  }
  const now = deps.clock.now()
  const experiment = await deps.repository.createExperiment({ ownerUserId, ...input, status: 'draft', startedAt: null, concludedAt: null, createdAt: now, updatedAt: now })
  return { experiment, replayed: false, limitations: [] }
}

export async function listExperiments(ownerUserId: number, dependencies: Dependencies = {}) { return resolveInterventionLoopDependencies(dependencies).repository.listExperiments(ownerUserId) }

export async function attachInterventionToExperiment(ownerUserId: number, experimentId: number, value: unknown, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const input = parseAttachExperimentInput(value)
  const [experiment, intervention] = await Promise.all([deps.repository.getExperiment(ownerUserId, experimentId), deps.repository.getIntervention(ownerUserId, input.interventionId)])
  if (!experiment || !intervention) notFound('找不到實驗或介入紀錄。')
  if (experiment.status === 'concluded') conflict('INVALID_TRANSITION', '已結束的實驗不能再附加介入紀錄。')
  if (intervention.experimentId) {
    if (intervention.experimentId === experimentId && intervention.experimentGroup === input.group) return { intervention, experiment, replayed: true, limitations: ['idempotent_replay'] }
    conflict('ALREADY_ATTACHED', '這筆介入紀錄已附加到另一個實驗或不同分組。')
  }
  const now = deps.clock.now()
  const updated = await deps.repository.transition(ownerUserId, intervention.id, { experimentId, experimentGroup: input.group, updatedAt: now }, attachedEvent(ownerUserId, intervention.id, intervention.status, experimentId, input.group, now))
  if (!updated) notFound('找不到這筆介入紀錄。')
  const running = experiment.status === 'draft' ? await deps.repository.updateExperiment(ownerUserId, experiment.id, { status: 'running', startedAt: now, updatedAt: now }) : experiment
  if (!running) notFound()
  return { intervention: updated, experiment: running, replayed: false, limitations: [] }
}

function signal(delta: number | null, insufficient: boolean): InterventionSignal {
  if (insufficient || delta === null) return 'insufficient_data'
  if (Math.abs(delta) < 0.05) return 'no_material_change'
  return delta > 0 ? 'positive_signal' : 'negative_signal'
}

function latestPerIntervention(results: ExperimentResult[]) {
  const map = new Map<number, ExperimentResult>()
  for (const result of results) if (result.interventionId !== null && !map.has(result.interventionId)) map.set(result.interventionId, result)
  return map
}

export async function concludeExperiment(ownerUserId: number, experimentId: number, dependencies: Dependencies = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const experiment = await deps.repository.getExperiment(ownerUserId, experimentId)
  if (!experiment) notFound()
  const priorResults = await deps.repository.listResultsForExperiment(ownerUserId, experimentId)
  const existingAggregate = priorResults.find(result => result.interventionId === null && result.resultKind === (experiment.design === 'grouped' ? 'grouped_difference' : 'pre_post'))
  if (experiment.status === 'concluded' && existingAggregate) return { experiment, result: existingAggregate, replayed: true, limitations: existingAggregate.limitations }
  const attached = (await listAllInterventions(deps.repository, ownerUserId)).filter(row => row.experimentId === experimentId)
  const unassessed = attached.filter(row => row.status !== 'assessed').map(row => row.id)
  if (unassessed.length) conflict('INVALID_TRANSITION', `下列介入尚未完成評估：${unassessed.join(', ')}。`)
  if (!attached.length) conflict('INVALID_TRANSITION', '實驗尚未附加任何介入紀錄。')
  const latest = latestPerIntervention(priorResults)
  const now = deps.clock.now(); const policy = await deps.repository.getPolicy(ownerUserId) || { minimumSampleSize: 30 }
  let resultInput: Omit<Parameters<typeof deps.repository.createResult>[0], 'id'>
  if (experiment.design === 'pre_post') {
    const rows = attached.map(row => latest.get(row.id)).filter((row): row is ExperimentResult => Boolean(row))
    if (rows.length !== attached.length) conflict('INVALID_TRANSITION', '部分介入缺少前後比較結果。')
    const deltas = rows.map(latestRelativeClicksDelta).filter((value): value is number => value !== null)
    const meanRelativeDelta = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null
    const sampleSizeBaseline = rows.reduce((sum, row) => sum + row.sampleSizeBaseline, 0); const sampleSizeFollowUp = rows.reduce((sum, row) => sum + row.sampleSizeFollowUp, 0)
    const limitations = ['pre_post_not_experiment', 'no_control_group']; if (sampleSizeBaseline < policy.minimumSampleSize || sampleSizeFollowUp < policy.minimumSampleSize) limitations.push('sample_below_minimum')
    const effect = { interventions: rows.length, meanRelativeClicksPerDayDelta: meanRelativeDelta }
    const resultFingerprint = fingerprint({ experimentId, resultKind: 'pre_post', metric: 'clicksPerDay', sampleSizeBaseline, sampleSizeFollowUp, effect, limitations })
    resultInput = { ownerUserId, experimentId, interventionId: null, resultKind: 'pre_post', metric: 'clicksPerDay', sampleSizeBaseline, sampleSizeFollowUp, effect, signal: signal(meanRelativeDelta, limitations.includes('sample_below_minimum')), limitations, causalStatement: '這是多個頁面的前後比較彙總，不是對照實驗；結果只能視為相關，不能視為因果。', computedAt: now, resultFingerprint, createdAt: now, updatedAt: now }
  } else {
    const treatment = attached.filter(row => row.experimentGroup === 'treatment'); const control = attached.filter(row => row.experimentGroup === 'control')
    if (!treatment.length || !control.length) conflict('INVALID_TRANSITION', '分組實驗至少需要一筆 treatment 與一筆 control。')
    const treatmentResults = treatment.map(row => latest.get(row.id)).filter((row): row is ExperimentResult => Boolean(row)); const controlResults = control.map(row => latest.get(row.id)).filter((row): row is ExperimentResult => Boolean(row))
    if (treatmentResults.length !== treatment.length || controlResults.length !== control.length) conflict('INVALID_TRANSITION', '部分分組介入缺少前後比較結果。')
    const treatmentDeltas = treatmentResults.map(latestRelativeClicksDelta).filter((value): value is number => value !== null); const controlDeltas = controlResults.map(latestRelativeClicksDelta).filter((value): value is number => value !== null)
    const treatmentMean = treatmentDeltas.length ? treatmentDeltas.reduce((sum, value) => sum + value, 0) / treatmentDeltas.length : null; const controlMean = controlDeltas.length ? controlDeltas.reduce((sum, value) => sum + value, 0) / controlDeltas.length : null
    const difference = treatmentMean === null || controlMean === null ? null : treatmentMean - controlMean
    const sampleSizeBaseline = treatmentResults.reduce((sum, row) => sum + row.sampleSizeBaseline + row.sampleSizeFollowUp, 0); const sampleSizeFollowUp = controlResults.reduce((sum, row) => sum + row.sampleSizeBaseline + row.sampleSizeFollowUp, 0)
    const limitations = ['no_randomization']; if (treatment.length < 3 || control.length < 3) limitations.push('small_group'); if (sampleSizeBaseline < policy.minimumSampleSize || sampleSizeFollowUp < policy.minimumSampleSize) limitations.push('sample_below_minimum')
    const effect = { treatment: { interventions: treatment.length, meanRelativeClicksPerDayDelta: treatmentMean, n: sampleSizeBaseline }, control: { interventions: control.length, meanRelativeClicksPerDayDelta: controlMean, n: sampleSizeFollowUp }, differenceInRelativeDelta: difference, sampleSizeMapping: { sampleSizeBaseline: 'treatment_total_n', sampleSizeFollowUp: 'control_total_n' } }
    const resultFingerprint = fingerprint({ experimentId, resultKind: 'grouped_difference', metric: 'clicksPerDay', sampleSizeBaseline, sampleSizeFollowUp, effect, limitations })
    resultInput = { ownerUserId, experimentId, interventionId: null, resultKind: 'grouped_difference', metric: 'clicksPerDay', sampleSizeBaseline, sampleSizeFollowUp, effect, signal: signal(difference, limitations.includes('sample_below_minimum')), limitations, causalStatement: GROUPED_CAUSAL_STATEMENT, computedAt: now, resultFingerprint, createdAt: now, updatedAt: now }
  }
  const result = await deps.repository.createResult(resultInput)
  const concluded = await deps.repository.updateExperiment(ownerUserId, experimentId, { status: 'concluded', concludedAt: now, updatedAt: now })
  if (!concluded) notFound()
  return { experiment: concluded, result, replayed: false, limitations: result.limitations }
}
