import { fingerprint, SystemFactoryError } from './canonical'
import type { CompiledSystemPlan } from './compiler'
import type { SystemSpec } from './system-spec'

export type SystemPreview = {
  schemaVersion: 'system-preview-v1'
  previewId: string
  version: number
  parentPreviewId: string | null
  specFingerprint: string
  compiledPlanFingerprint: string
  fixtureFingerprint: string
  status: 'preview_ready' | 'expired' | 'superseded'
  previewOnly: true
  deployed: false
  connectedToProductionErp: false
  connectedToPayment: false
  connectedToInvoice: false
  connectedToLine: false
  containsProductionData: false
  noProductionDataMarker: 'SYNTHETIC_DEMO_DATA_ONLY'
  createdAt: string
  expiresAt: string
  fixtures: Record<string, Array<Record<string, unknown>>>
  dashboard: Array<{ key: string; label: string; value: null; source: 'synthetic_preview'; limitation: string }>
}

function demoValue(type: string, entity: string, field: string, index: number): unknown {
  if (type === 'integer' || type === 'decimal' || type === 'currency') return (index + 1) * 10
  if (type === 'boolean') return index % 2 === 0
  if (type === 'date') return `2030-01-${String(index + 1).padStart(2, '0')}`
  if (type === 'datetime') return `2030-01-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`
  if (type === 'email') return `demo-${index + 1}@example.invalid`
  if (type === 'phone') return `+00000000${index + 1}`
  if (type === 'select') return 'draft'
  return `Demo ${entity} ${field} ${index + 1}`
}

export function buildSystemPreview(spec: SystemSpec, plan: CompiledSystemPlan, input: { version: number; parentPreviewId?: string | null; now?: Date; ttlMs?: number }): SystemPreview {
  if (plan.specFingerprint !== spec.fingerprint) throw new SystemFactoryError('PREVIEW_LINEAGE', 'Preview compile lineage is mismatched.', 409)
  const now = input.now || new Date(); if (!Number.isFinite(now.getTime())) throw new SystemFactoryError('INVALID_CLOCK', 'Preview clock is invalid.')
  const count = spec.previewSeedPolicy.fixtureCountPerEntity
  const fixtures = Object.fromEntries(spec.entities.map(entity => [entity.key, Array.from({ length: count }, (_, index) => Object.fromEntries([['__demo', true], ['__fixtureId', `${entity.key}-demo-${index + 1}`], ...entity.fields.map(field => [field.key, demoValue(field.type, entity.key, field.key, index)])]))]))
  const fixtureFingerprint = fingerprint(fixtures)
  const draft = { schemaVersion: 'system-preview-v1' as const, version: input.version, parentPreviewId: input.parentPreviewId || null, specFingerprint: spec.fingerprint, compiledPlanFingerprint: plan.planFingerprint, fixtureFingerprint, status: 'preview_ready' as const, previewOnly: true as const, deployed: false as const, connectedToProductionErp: false as const, connectedToPayment: false as const, connectedToInvoice: false as const, connectedToLine: false as const, containsProductionData: false as const, noProductionDataMarker: 'SYNTHETIC_DEMO_DATA_ONLY' as const, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + (input.ttlMs || 86_400_000)).toISOString(), fixtures, dashboard: spec.kpis.map(kpi => ({ key: kpi.key, label: kpi.label, value: null, source: 'synthetic_preview' as const, limitation: 'No production data is connected; this preview does not claim a KPI result.' })) }
  return { ...draft, previewId: `system-preview-${fingerprint(draft).slice(0, 24)}` }
}

export function reviseSystemPreview(previous: SystemPreview, spec: SystemSpec, plan: CompiledSystemPlan, now = new Date()): { previous: SystemPreview; current: SystemPreview } {
  if (previous.status !== 'preview_ready') throw new SystemFactoryError('PREVIEW_TERMINAL', 'Only a ready preview may be revised.', 409)
  return { previous: { ...previous, status: 'superseded' }, current: buildSystemPreview(spec, plan, { version: previous.version + 1, parentPreviewId: previous.previewId, now }) }
}
