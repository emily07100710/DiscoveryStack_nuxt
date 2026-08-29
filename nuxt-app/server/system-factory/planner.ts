import { TEMPLATE_CATALOG, type SystemCapability, type SystemTemplateKey } from './catalog'
import { fingerprint, normalizeText, SystemFactoryError } from './canonical'
import { ERP_MODULE_DOCTYPES, parseSystemSpec, type SystemEntity, type SystemField, type SystemSpec } from './system-spec'

export type SystemPlannerInput = {
  requirements: string
  identity: SystemSpec['identity']
  businessType: string
  industry: string
  preferredTemplate?: SystemTemplateKey
  requestedCapabilities?: SystemCapability[]
  version?: number
  parentFingerprint?: string | null
}

export type SystemPlannerPort = { plan(input: SystemPlannerInput): Promise<unknown> }

const ENTITY_DOC_TYPES: Record<string, string> = {
  lead: 'Lead', customer: 'Customer', opportunity: 'Opportunity', project: 'Project', task: 'Task', timesheet: 'Timesheet', issue: 'Issue', item: 'Item', warehouse: 'Warehouse', stock_entry: 'Stock Entry', supplier: 'Supplier', purchase_order: 'Purchase Order', sales_order: 'Sales Order', course: 'Course', enrollment: 'Program Enrollment', member: 'Student',
}

const FIELDS: Record<string, Array<[string, string, SystemField['type']]>> = {
  lead: [['lead_name', 'Lead name', 'text'], ['email', 'Email', 'email'], ['status', 'Status', 'select']],
  customer: [['customer_name', 'Customer name', 'text'], ['email', 'Email', 'email'], ['phone', 'Phone', 'phone']],
  opportunity: [['title', 'Opportunity', 'text'], ['amount', 'Expected amount', 'currency'], ['status', 'Status', 'select']],
  appointment: [['starts_at', 'Starts at', 'datetime'], ['ends_at', 'Ends at', 'datetime'], ['status', 'Status', 'select']],
  service: [['service_name', 'Service name', 'text'], ['duration_minutes', 'Duration minutes', 'integer']],
  resource: [['resource_name', 'Resource name', 'text']], availability: [['starts_at', 'Starts at', 'datetime'], ['ends_at', 'Ends at', 'datetime']], note: [['body', 'Note', 'long_text']], activity: [['subject', 'Subject', 'text'], ['occurred_at', 'Occurred at', 'datetime']],
  member: [['member_name', 'Member name', 'text'], ['email', 'Email', 'email']], membership: [['plan_name', 'Plan', 'text'], ['status', 'Status', 'select']], course: [['course_name', 'Course', 'text']], enrollment: [['status', 'Status', 'select']], lesson: [['title', 'Lesson', 'text']], attendance: [['date', 'Date', 'date']],
  project: [['project_name', 'Project name', 'text'], ['status', 'Status', 'select']], task: [['subject', 'Subject', 'text'], ['status', 'Status', 'select']], timesheet: [['hours', 'Hours', 'decimal']], milestone: [['title', 'Milestone', 'text'], ['due_date', 'Due date', 'date']], issue: [['subject', 'Subject', 'text'], ['status', 'Status', 'select']],
  item: [['item_name', 'Item name', 'text'], ['sku', 'SKU', 'text']], warehouse: [['warehouse_name', 'Warehouse', 'text']], sales_order: [['order_reference', 'Order reference', 'text'], ['total', 'Total', 'currency'], ['status', 'Status', 'select']], purchase_order: [['order_reference', 'Order reference', 'text'], ['total', 'Total', 'currency']], stock_entry: [['quantity', 'Quantity', 'decimal']], supplier: [['supplier_name', 'Supplier', 'text']], payment_reference: [['receipt_fingerprint', 'Verified receipt fingerprint', 'text']],
}

function field([key, label, type]: [string, string, SystemField['type']]): SystemField {
  return { key, label, type, required: key.endsWith('_name') || key === 'subject' || key === 'starts_at', unique: key === 'sku' || key === 'receipt_fingerprint', sensitive: key === 'email' || key === 'phone', readOnly: key === 'receipt_fingerprint', options: type === 'select' ? ['active', 'cancelled', 'draft'] : [], linkEntity: null }
}

function entity(key: string): SystemEntity {
  const erpNextDocType = ENTITY_DOC_TYPES[key] || null
  return { key, label: key.split('_').map(part => part[0]!.toUpperCase() + part.slice(1)).join(' '), kind: erpNextDocType ? 'erpnext' : 'custom', erpNextDocType, fields: (FIELDS[key] || [['name', 'Name', 'text']]).map(field) }
}

function inferTemplate(requirements: string, preferred?: SystemTemplateKey): SystemTemplateKey {
  if (preferred) return preferred
  const value = requirements.normalize('NFKC').toLocaleLowerCase('en-US')
  if (/預約|booking|appointment/u.test(value)) return 'appointment_booking'
  if (/會員|課程|member|course/u.test(value)) return 'membership_course'
  if (/庫存|進銷|inventory|warehouse/u.test(value)) return 'inventory_sales'
  if (/零售|retail/u.test(value)) return 'retail_light'
  if (/專案|project|task/u.test(value)) return 'service_project'
  return 'light_crm'
}

export function createGuidedSystemSpec(input: SystemPlannerInput): SystemSpec {
  const requirements = normalizeText(input.requirements, 'Requirements', 8_000, 8)
  const systemTemplate = inferTemplate(requirements, input.preferredTemplate)
  const template = TEMPLATE_CATALOG[systemTemplate]
  const modules = [...new Set(input.requestedCapabilities || template.capabilities)].filter(module => template.capabilities.includes(module)).sort()
  if (input.requestedCapabilities?.some(module => !template.capabilities.includes(module))) throw new SystemFactoryError('TEMPLATE_CAPABILITY', 'Requested capability is outside the chosen template.')
  const entities = template.requiredEntities.map(entity)
  const roles = template.roles.map((key, index) => ({ key, label: key.split('_').map(part => part[0]!.toUpperCase() + part.slice(1)).join(' '), permissions: entities.map(current => ({ entity: current.key, actions: index === template.roles.length - 1 || key.endsWith('viewer') ? ['read' as const] : ['create' as const, 'read' as const, 'update' as const] })) }))
  const primary = entities[0]
  const statuses = primary ? [{ entity: primary.key, values: ['active', 'cancelled', 'draft'], initial: 'draft', terminal: ['cancelled'] }] : []
  const workflows = primary ? [{ key: `${primary.key}_lifecycle`, entity: primary.key, transitions: [{ from: 'draft', to: 'active', roles: [roles[0]!.key] }, { from: 'active', to: 'cancelled', roles: [roles[0]!.key] }] }] : []
  const reports = entities.slice(0, 8).map(current => ({ key: `${current.key}_count`, label: `${current.label} count`, entity: current.key, measure: 'count' as const, field: null, timeWindowDays: 30, limitations: ['Operational count only; it is not a causal or revenue claim.'] }))
  const draft: Omit<SystemSpec, 'fingerprint'> = {
    schemaVersion: 'system-spec-v1', identity: { ...input.identity, systemTenantId: input.identity.systemTenantId || null }, businessType: normalizeText(input.businessType, 'Business type', 120), industry: normalizeText(input.industry, 'Industry', 120), systemTemplate, modules, entities, relationships: [], statuses, workflows, roles,
    views: entities.map(current => ({ key: `${current.key}_list`, entity: current.key, fields: current.fields.slice(0, 6).map(item => item.key), kind: current.key === 'appointment' ? 'calendar' as const : 'list' as const })), reports,
    kpis: reports.slice(0, 4).map(report => ({ key: `${report.key}_kpi`, label: report.label, reportKey: report.key, denominatorReportKey: null, source: 'operational' as const, limitations: [...report.limitations] })),
    notificationIntents: [], integrationIntents: [{ key: 'managed_site_binding', type: 'managed_site', enabled: true, credentialReference: null, writeEnabled: false }, { key: 'content_projection', type: 'publication_projection', enabled: false, credentialReference: null, writeEnabled: false }],
    retention: { operationalDays: 730, auditDays: 2555, recoverableDeprovisionDays: 30 }, audit: { enabled: true, appendOnly: true, includeActor: true }, previewSeedPolicy: { syntheticOnly: true, fixtureCountPerEntity: 3, containsProductionData: false }, provisioningPreferences: { region: 'auto', separateDatabase: true, deskAccess: 'restricted', backupBeforeUpgrade: true }, version: input.version || 1, parentFingerprint: input.parentFingerprint || null,
  }
  return parseSystemSpec({ ...draft, fingerprint: '' })
}

export async function planSystemSpec(input: SystemPlannerInput, provider?: SystemPlannerPort): Promise<{ spec: SystemSpec; mode: 'provider_structured' | 'guided_deterministic'; requestFingerprint: string }> {
  const requestFingerprint = fingerprint(input)
  if (!provider) return { spec: createGuidedSystemSpec(input), mode: 'guided_deterministic', requestFingerprint }
  const output = await provider.plan(input)
  return { spec: parseSystemSpec(output), mode: 'provider_structured', requestFingerprint }
}

export function allowedDocTypesForTemplate(template: SystemTemplateKey): string[] {
  return TEMPLATE_CATALOG[template].erpNextModules.flatMap(module => ERP_MODULE_DOCTYPES[module] || []).sort()
}
