import { aggregateMeasurements, classifyMeasurementPhases } from './assessment'
import { resolveInterventionLoopDependencies } from './dependencies'
import type { InterventionLoopDependencies } from './dependencies'
import { sha256Hex } from '../site-evidence/normalization'
import { listAllInterventions } from './paging'

export async function exportInterventionOutcomeDataset(ownerUserId: number, dependencies: Partial<InterventionLoopDependencies> = {}) {
  const deps = resolveInterventionLoopDependencies(dependencies); const generatedAt = deps.clock.now()
  const rows = await listAllInterventions(deps.repository, ownerUserId)
  const interventions = []
  for (const row of rows) {
    const [measurements, results, experiment] = await Promise.all([
      deps.repository.listMeasurements(ownerUserId, row.id),
      deps.repository.listResultsForIntervention(ownerUserId, row.id),
      row.experimentId ? deps.repository.getExperiment(ownerUserId, row.experimentId) : Promise.resolve(null),
    ])
    const phases = classifyMeasurementPhases(row, measurements)
    const phase = (items: typeof measurements) => items.length ? { rows: items.length, n: items.reduce((sum, item) => sum + item.sampleSize, 0), aggregates: aggregateMeasurements(items) } : null
    interventions.push({
      id: row.id,
      urlHash: row.urlHash,
      siteHost: row.siteHost,
      normalizedUrl: row.normalizedUrl,
      interventionType: row.interventionType,
      registrationSource: row.registrationSource,
      status: row.status,
      registeredAt: row.registeredAt,
      deployedAt: row.deployedAt,
      deployEvidenceLevel: row.deployEvidenceLevel,
      deployEvidenceSource: row.deployEvidenceSource,
      recrawlStatus: row.recrawlStatus,
      recrawlSource: row.recrawlSource,
      recrawlConfirmedAt: row.recrawlConfirmedAt,
      experiment: experiment ? { id: experiment.id, design: experiment.design, group: row.experimentGroup } : null,
      baseline: phase(phases.baseline),
      followUp: phase(phases.followUp),
      results: results.map(result => ({ resultKind: result.resultKind, metric: result.metric, sampleSizeBaseline: result.sampleSizeBaseline, sampleSizeFollowUp: result.sampleSizeFollowUp, effect: result.effect, signal: result.signal, limitations: result.limitations, causalStatement: result.causalStatement, computedAt: result.computedAt })),
    })
  }
  const statusCounts = Object.fromEntries([...new Set(rows.map(row => row.status))].sort().map(status => [status, rows.filter(row => row.status === status).length]))
  return { datasetVersion: 'intervention-outcome-v1' as const, generatedAt, ownerKey: sha256Hex(`intervention-loop:${ownerUserId}`), interventions, counts: { interventions: interventions.length, results: interventions.reduce((sum, row) => sum + row.results.length, 0), byStatus: statusCounts }, limitations: ['pre_post_only', 'owner_scoped', 'observational_not_causal', 'free_text_excluded'] }
}
