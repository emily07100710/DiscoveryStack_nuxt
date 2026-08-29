import { COMPILED_PLAN_VERSION, MATERIALIZATION_MANIFEST_VERSION, RESERVED_DOCTYPES, SYSTEM_COMPILER_VERSION, TEMPLATE_CATALOG } from './catalog'
import { canonicalJson, fingerprint, SystemFactoryError } from './canonical'
import { parseSystemSpec, type SystemSpec } from './system-spec'

export const FRAPPE_FIELD_TYPE_MAP = { text: 'Data', long_text: 'Long Text', integer: 'Int', decimal: 'Float', boolean: 'Check', date: 'Date', datetime: 'Datetime', email: 'Data', phone: 'Data', currency: 'Currency', select: 'Select', link: 'Link' } as const
const ERP_FIELD_BINDINGS: Record<string, Record<string, string>> = {
  Lead: { lead_name: 'lead_name', email: 'email_id', status: 'status' }, Customer: { customer_name: 'customer_name', email: 'email_id', phone: 'mobile_no' }, Opportunity: { title: 'title', amount: 'opportunity_amount', status: 'status' }, Project: { project_name: 'project_name', status: 'status' }, Task: { subject: 'subject', status: 'status' }, Timesheet: { hours: 'total_hours' }, Issue: { subject: 'subject', status: 'status' }, Item: { item_name: 'item_name', sku: 'item_code' }, Warehouse: { warehouse_name: 'warehouse_name' }, 'Sales Order': { order_reference: 'po_no', total: 'grand_total', status: 'status' }, 'Purchase Order': { order_reference: 'supplier_order_reference', total: 'grand_total' }, 'Stock Entry': { quantity: 'total_outgoing_value' }, Supplier: { supplier_name: 'supplier_name' }, Course: { course_name: 'course_name' }, Student: { member_name: 'student_name', email: 'student_email_id' }, 'Program Enrollment': { status: 'docstatus' },
}
type MaterializationBase = { key: string; definitionFingerprint: string }
export type CompiledField = SystemSpec['entities'][number]['fields'][number] & { targetField: string; frappeFieldType: typeof FRAPPE_FIELD_TYPE_MAP[keyof typeof FRAPPE_FIELD_TYPE_MAP] }
export type CompiledUnit = MaterializationBase & (
  | { kind: 'module'; erpNextModule: string; mode: 'existing_binding' }
  | { kind: 'doctype'; source: string; mode: 'existing_binding' | 'custom_doctype'; fields: CompiledField[] }
  | { kind: 'status'; entity: string; values: string[]; initial: string; terminal: string[] }
  | { kind: 'workflow'; entity: string; transitions: SystemSpec['workflows'][number]['transitions'] }
  | { kind: 'role'; label: string; permissions: Array<{ entity: string; actions: Array<'create' | 'read' | 'write'> }> }
  | { kind: 'view'; definition: SystemSpec['views'][number] & { materialization: 'desk_ready' | 'registry_only' } }
  | { kind: 'report'; definition: SystemSpec['reports'][number] }
  | { kind: 'kpi'; definition: SystemSpec['kpis'][number] }
  | { kind: 'workspace'; definition: { viewKeys: string[]; reportKeys: string[]; kpiKeys: string[]; roleKeys: string[] } }
  | { kind: 'notification_intent'; definition: SystemSpec['notificationIntents'][number] & { effectiveEnabled: false } }
  | { kind: 'integration_intent'; definition: SystemSpec['integrationIntents'][number] & { effectiveEnabled: false } }
)

export type MaterializationManifest = { schemaVersion: typeof MATERIALIZATION_MANIFEST_VERSION; units: CompiledUnit[]; fingerprint: string }
export type CompiledSystemPlan = { schemaVersion: typeof COMPILED_PLAN_VERSION; compilerVersion: typeof SYSTEM_COMPILER_VERSION; specId: string; specVersion: number; specFingerprint: string; parentFingerprint: string | null; tenantBinding: SystemSpec['identity']; materializationManifest: MaterializationManifest; canonicalSpecJson: string; planFingerprint: string }

function unit<T extends Omit<CompiledUnit, 'definitionFingerprint'>>(definition: T): T & MaterializationBase { return { ...definition, definitionFingerprint: fingerprint(definition) } }

export function compileSystemSpec(input: unknown): CompiledSystemPlan {
  const spec = parseSystemSpec(input)
  const template = TEMPLATE_CATALOG[spec.systemTemplate]
  const units: CompiledUnit[] = []
  for (const erpNextModule of [...template.erpNextModules].sort()) units.push(unit({ kind: 'module', key: erpNextModule.toLocaleLowerCase('en-US').replace(/\s+/gu, '_'), erpNextModule, mode: 'existing_binding' }))
  for (const entity of spec.entities) {
    const source = entity.erpNextDocType || `DiscoveryStack ${entity.label}`
    if (RESERVED_DOCTYPES.has(source.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, '_'))) throw new SystemFactoryError('RESERVED_DOCTYPE', 'SystemSpec cannot target a reserved/system DocType.')
    const bindings = entity.erpNextDocType ? ERP_FIELD_BINDINGS[entity.erpNextDocType] : null
    const fields = entity.fields.map(field => {
      const targetField = bindings ? bindings[field.key] : field.key
      if (!targetField) throw new SystemFactoryError('ERP_FIELD_BINDING', 'ERPNext field mapping is not allowlisted for this entity.', 409)
      return { ...field, targetField, frappeFieldType: FRAPPE_FIELD_TYPE_MAP[field.type] }
    })
    units.push(unit({ kind: 'doctype', key: entity.key, source, mode: entity.kind === 'custom' ? 'custom_doctype' : 'existing_binding', fields }))
  }
  for (const status of spec.statuses) units.push(unit({ kind: 'status', key: `${status.entity}_statuses`, ...status }))
  for (const role of spec.roles) units.push(unit({ kind: 'role', key: role.key, label: role.label, permissions: role.permissions.map(permission => ({ entity: permission.entity, actions: permission.actions.map(action => action === 'update' ? 'write' as const : action).filter((action): action is 'create' | 'read' | 'write' => ['create', 'read', 'write'].includes(action)) })) }))
  for (const workflow of spec.workflows) units.push(unit({ kind: 'workflow', key: workflow.key, entity: workflow.entity, transitions: workflow.transitions }))
  for (const view of spec.views) units.push(unit({ kind: 'view', key: view.key, definition: { ...view, materialization: view.kind === 'list' || view.kind === 'form' ? 'desk_ready' : 'registry_only' } }))
  for (const report of spec.reports) units.push(unit({ kind: 'report', key: report.key, definition: report }))
  for (const kpi of spec.kpis) units.push(unit({ kind: 'kpi', key: kpi.key, definition: kpi }))
  units.push(unit({ kind: 'workspace', key: 'tenant_workspace', definition: { viewKeys: spec.views.map(item => item.key).sort(), reportKeys: spec.reports.map(item => item.key).sort(), kpiKeys: spec.kpis.map(item => item.key).sort(), roleKeys: spec.roles.map(item => item.key).sort() } }))
  for (const notification of spec.notificationIntents) units.push(unit({ kind: 'notification_intent', key: notification.key, definition: { ...notification, effectiveEnabled: false } }))
  for (const integration of spec.integrationIntents) units.push(unit({ kind: 'integration_intent', key: integration.key, definition: { ...integration, effectiveEnabled: false } }))
  const order: Record<CompiledUnit['kind'], number> = { module: 1, doctype: 2, status: 3, role: 4, workflow: 5, view: 6, report: 7, kpi: 8, workspace: 9, notification_intent: 10, integration_intent: 11 }
  units.sort((left, right) => order[left.kind] - order[right.kind] || left.key.localeCompare(right.key))
  const manifestDraft = { schemaVersion: MATERIALIZATION_MANIFEST_VERSION, units }
  const materializationManifest = { ...manifestDraft, fingerprint: fingerprint(manifestDraft) }
  const draft = { schemaVersion: COMPILED_PLAN_VERSION, compilerVersion: SYSTEM_COMPILER_VERSION, specId: spec.identity.specId, specVersion: spec.version, specFingerprint: spec.fingerprint, parentFingerprint: spec.parentFingerprint, tenantBinding: spec.identity, materializationManifest, canonicalSpecJson: canonicalJson(spec) }
  return { ...draft, planFingerprint: fingerprint(draft) }
}

export function assertCompileReplay(existing: CompiledSystemPlan | null, idempotencyKey: string, payload: unknown, replayIndex: Map<string, string>): CompiledSystemPlan {
  const requestFingerprint = fingerprint(payload)
  const prior = replayIndex.get(idempotencyKey)
  if (prior && prior !== requestFingerprint) throw new SystemFactoryError('IDEMPOTENCY_COLLISION', 'Idempotency key is already associated with a different SystemSpec.', 409)
  const compiled = compileSystemSpec(payload)
  if (existing && existing.specFingerprint !== compiled.specFingerprint) throw new SystemFactoryError('COMPILE_COLLISION', 'Stored compile lineage does not match the normalized SystemSpec.', 409)
  replayIndex.set(idempotencyKey, requestFingerprint)
  return existing || compiled
}
