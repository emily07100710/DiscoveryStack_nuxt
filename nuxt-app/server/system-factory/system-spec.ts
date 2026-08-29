import { SYSTEM_CAPABILITIES, SYSTEM_SPEC_VERSION, SYSTEM_TEMPLATES, TEMPLATE_CATALOG, type SystemCapability, type SystemTemplateKey } from './catalog'
import { assertUniqueNormalized, fingerprint, normalizeKey, normalizeText, SystemFactoryError } from './canonical'

export const FIELD_TYPES = ['text', 'long_text', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'email', 'phone', 'currency', 'select', 'link'] as const
export const PERMISSION_ACTIONS = ['read', 'create', 'update', 'delete', 'submit', 'cancel', 'export'] as const
export const INTEGRATION_INTENTS = ['managed_site', 'content_operations', 'publication_projection', 'geo_aggregate_outcomes', 'email', 'calendar', 'payment_receipt_reference'] as const

export type SystemField = { key: string; label: string; type: typeof FIELD_TYPES[number]; required: boolean; unique: boolean; sensitive: boolean; readOnly: boolean; options: string[]; linkEntity: string | null }
export type SystemEntity = { key: string; label: string; kind: 'erpnext' | 'custom'; erpNextDocType: string | null; fields: SystemField[] }
export type SystemRole = { key: string; label: string; permissions: Array<{ entity: string; actions: Array<typeof PERMISSION_ACTIONS[number]> }> }
export type SystemSpec = {
  schemaVersion: typeof SYSTEM_SPEC_VERSION
  identity: { specId: string; ownerId: string; clientId: string; websiteId: string | null; managedSiteId: string | null; systemTenantId: string | null; locale: 'en' | 'zh-hant'; timezone: string; currency: string }
  businessType: string
  industry: string
  systemTemplate: SystemTemplateKey
  modules: SystemCapability[]
  entities: SystemEntity[]
  relationships: Array<{ key: string; fromEntity: string; toEntity: string; cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one'; required: boolean }>
  statuses: Array<{ entity: string; values: string[]; initial: string; terminal: string[] }>
  workflows: Array<{ key: string; entity: string; transitions: Array<{ from: string; to: string; roles: string[] }> }>
  roles: SystemRole[]
  views: Array<{ key: string; entity: string; fields: string[]; kind: 'list' | 'form' | 'calendar' | 'kanban' }>
  reports: Array<{ key: string; label: string; entity: string; measure: 'count' | 'sum' | 'average'; field: string | null; timeWindowDays: number | null; limitations: string[] }>
  kpis: Array<{ key: string; label: string; reportKey: string; denominatorReportKey: string | null; source: 'operational' | 'aggregate_outcome'; limitations: string[] }>
  notificationIntents: Array<{ key: string; event: string; channel: 'email' | 'in_app'; recipientRole: string }>
  integrationIntents: Array<{ key: string; type: typeof INTEGRATION_INTENTS[number]; enabled: boolean; credentialReference: string | null; writeEnabled: boolean }>
  retention: { operationalDays: number; auditDays: number; recoverableDeprovisionDays: number }
  audit: { enabled: true; appendOnly: true; includeActor: true }
  previewSeedPolicy: { syntheticOnly: true; fixtureCountPerEntity: number; containsProductionData: false }
  provisioningPreferences: { region: 'auto' | 'ap-southeast'; separateDatabase: true; deskAccess: 'disabled' | 'restricted'; backupBeforeUpgrade: true }
  version: number
  parentFingerprint: string | null
  fingerprint: string
}

const BOUNDS = { entities: 24, fields: 32, roles: 12, relationships: 48, statuses: 24, workflows: 12, transitions: 24, views: 24, reports: 20, kpis: 12, notifications: 20, integrations: 12 }
const EXECUTABLE_PATTERN = /(?:<script|javascript:|\b(?:eval|exec|spawn|system)\s*\(|\b(?:select|insert|update|delete|drop|alter)\s+\b|\.\.[/\\]|\b(?:docker|bash|powershell|cmd\.exe)\b)/iu

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new SystemFactoryError('INVALID_OBJECT', `${label} must be a plain object.`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new SystemFactoryError('UNKNOWN_FIELD', `${label} contains an unknown field.`)
}

function bool(value: unknown, label: string, expected?: boolean): boolean {
  if (typeof value !== 'boolean' || (expected !== undefined && value !== expected)) throw new SystemFactoryError('INVALID_BOOLEAN', `${label} is invalid.`)
  return value
}

function boundedArray(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new SystemFactoryError('BOUND_EXCEEDED', `${label} exceeds its bound.`)
  return value
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new SystemFactoryError('UNKNOWN_CAPABILITY', `${label} is not allowlisted.`)
  return value as T
}

function positiveInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new SystemFactoryError('INVALID_INTEGER', `${label} is outside its bound.`)
  return Number(value)
}

function safeText(value: unknown, label: string, max: number): string {
  const result = normalizeText(value, label, max)
  if (EXECUTABLE_PATTERN.test(result)) throw new SystemFactoryError('EXECUTABLE_CONTENT', `${label} contains executable or path content.`)
  return result
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  const result = normalizeText(value, label, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{1,127}$/u.test(result)) throw new SystemFactoryError('INVALID_IDENTITY', `${label} is invalid.`)
  return result
}

function parseField(value: unknown, entityKey: string): SystemField {
  const item = object(value, 'Field')
  exact(item, ['key', 'label', 'type', 'required', 'unique', 'sensitive', 'readOnly', 'options', 'linkEntity'], 'Field')
  const type = enumValue(item.type, FIELD_TYPES, 'Field type')
  const options = boundedArray(item.options ?? [], 'Field options', 32).map((entry, index) => safeText(entry, `Field option ${index + 1}`, 120)).sort()
  assertUniqueNormalized(options, entry => entry, 'Field options')
  const linkEntity = item.linkEntity === null || item.linkEntity === undefined ? null : normalizeKey(item.linkEntity, 'Linked entity')
  if (type === 'select' && options.length < 1) throw new SystemFactoryError('INVALID_FIELD', 'Select fields require options.')
  if (type === 'link' && !linkEntity) throw new SystemFactoryError('INVALID_FIELD', 'Link fields require linkEntity.')
  return { key: normalizeKey(item.key, `${entityKey} field key`), label: safeText(item.label, 'Field label', 120), type, required: bool(item.required, 'Field required'), unique: bool(item.unique, 'Field unique'), sensitive: bool(item.sensitive, 'Field sensitive'), readOnly: bool(item.readOnly, 'Field readOnly'), options, linkEntity }
}

function parseEntity(value: unknown): SystemEntity {
  const item = object(value, 'Entity')
  exact(item, ['key', 'label', 'kind', 'erpNextDocType', 'fields'], 'Entity')
  const key = normalizeKey(item.key, 'Entity key')
  const kind = enumValue(item.kind, ['erpnext', 'custom'] as const, 'Entity kind')
  const erpNextDocType = item.erpNextDocType === null || item.erpNextDocType === undefined ? null : safeText(item.erpNextDocType, 'ERPNext DocType', 140)
  if (kind === 'erpnext' && !erpNextDocType) throw new SystemFactoryError('INVALID_ENTITY', 'ERPNext entities require an allowlisted DocType mapping.')
  if (kind === 'custom' && erpNextDocType) throw new SystemFactoryError('INVALID_ENTITY', 'Custom entities cannot name an ERPNext core DocType.')
  const fields = boundedArray(item.fields, 'Entity fields', BOUNDS.fields).map(field => parseField(field, key)).sort((a, b) => a.key.localeCompare(b.key))
  assertUniqueNormalized(fields, field => field.key, `${key} fields`)
  return { key, label: safeText(item.label, 'Entity label', 120), kind, erpNextDocType, fields }
}

function parseRole(value: unknown): SystemRole {
  const item = object(value, 'Role')
  exact(item, ['key', 'label', 'permissions'], 'Role')
  const permissions = boundedArray(item.permissions, 'Role permissions', 48).map(value => {
    const permission = object(value, 'Permission')
    exact(permission, ['entity', 'actions'], 'Permission')
    const actions = boundedArray(permission.actions, 'Permission actions', PERMISSION_ACTIONS.length).map(action => enumValue(action, PERMISSION_ACTIONS, 'Permission action')).sort()
    assertUniqueNormalized(actions, action => action, 'Permission actions')
    return { entity: normalizeKey(permission.entity, 'Permission entity'), actions }
  }).sort((a, b) => a.entity.localeCompare(b.entity))
  assertUniqueNormalized(permissions, permission => permission.entity, 'Role permissions')
  return { key: normalizeKey(item.key, 'Role key'), label: safeText(item.label, 'Role label', 120), permissions }
}

export function parseSystemSpec(input: unknown): SystemSpec {
  const value = object(input, 'SystemSpec')
  exact(value, ['schemaVersion', 'identity', 'businessType', 'industry', 'systemTemplate', 'modules', 'entities', 'relationships', 'statuses', 'workflows', 'roles', 'views', 'reports', 'kpis', 'notificationIntents', 'integrationIntents', 'retention', 'audit', 'previewSeedPolicy', 'provisioningPreferences', 'version', 'parentFingerprint', 'fingerprint'], 'SystemSpec')
  if (value.schemaVersion !== SYSTEM_SPEC_VERSION) throw new SystemFactoryError('SCHEMA_VERSION', 'SystemSpec schema version is not supported.')
  const identityInput = object(value.identity, 'Identity')
  exact(identityInput, ['specId', 'ownerId', 'clientId', 'websiteId', 'managedSiteId', 'systemTenantId', 'locale', 'timezone', 'currency'], 'Identity')
  const identity = { specId: nullableId(identityInput.specId, 'specId')!, ownerId: nullableId(identityInput.ownerId, 'ownerId')!, clientId: nullableId(identityInput.clientId, 'clientId')!, websiteId: nullableId(identityInput.websiteId, 'websiteId'), managedSiteId: nullableId(identityInput.managedSiteId, 'managedSiteId'), systemTenantId: nullableId(identityInput.systemTenantId, 'systemTenantId'), locale: enumValue(identityInput.locale, ['en', 'zh-hant'] as const, 'Locale'), timezone: safeText(identityInput.timezone, 'Timezone', 80), currency: safeText(identityInput.currency, 'Currency', 3).toUpperCase() }
  if (!identity.websiteId && !identity.managedSiteId) throw new SystemFactoryError('IDENTITY_LINEAGE', 'A websiteId or managedSiteId lineage is required.')
  if (!/^[A-Z]{3}$/u.test(identity.currency)) throw new SystemFactoryError('INVALID_CURRENCY', 'Currency must be an ISO-style three-letter code.')
  const systemTemplate = enumValue(value.systemTemplate, SYSTEM_TEMPLATES, 'System template')
  const modules = boundedArray(value.modules, 'Modules', SYSTEM_CAPABILITIES.length).map(module => enumValue(module, SYSTEM_CAPABILITIES, 'Module')).sort()
  assertUniqueNormalized(modules, module => module, 'Modules')
  const entities = boundedArray(value.entities, 'Entities', BOUNDS.entities).map(parseEntity).sort((a, b) => a.key.localeCompare(b.key))
  assertUniqueNormalized(entities, entity => entity.key, 'Entities')
  const roles = boundedArray(value.roles, 'Roles', BOUNDS.roles).map(parseRole).sort((a, b) => a.key.localeCompare(b.key))
  assertUniqueNormalized(roles, role => role.key, 'Roles')
  const entityKeys = new Set(entities.map(entity => entity.key)); const roleKeys = new Set(roles.map(role => role.key))
  for (const entity of entities) for (const field of entity.fields) if (field.linkEntity && !entityKeys.has(field.linkEntity)) throw new SystemFactoryError('UNKNOWN_ENTITY', 'Link field references an unknown entity.')
  for (const role of roles) for (const permission of role.permissions) if (!entityKeys.has(permission.entity)) throw new SystemFactoryError('UNKNOWN_ENTITY', 'Permission references an unknown entity.')
  const relationships = boundedArray(value.relationships, 'Relationships', BOUNDS.relationships).map(raw => { const item = object(raw, 'Relationship'); exact(item, ['key', 'fromEntity', 'toEntity', 'cardinality', 'required'], 'Relationship'); return { key: normalizeKey(item.key, 'Relationship key'), fromEntity: normalizeKey(item.fromEntity, 'Relationship source'), toEntity: normalizeKey(item.toEntity, 'Relationship target'), cardinality: enumValue(item.cardinality, ['one_to_one', 'one_to_many', 'many_to_one'] as const, 'Relationship cardinality'), required: bool(item.required, 'Relationship required') } }).sort((a, b) => a.key.localeCompare(b.key))
  assertUniqueNormalized(relationships, item => item.key, 'Relationships')
  if (relationships.some(item => !entityKeys.has(item.fromEntity) || !entityKeys.has(item.toEntity))) throw new SystemFactoryError('UNKNOWN_ENTITY', 'Relationship references an unknown entity.')
  const statuses = boundedArray(value.statuses, 'Statuses', BOUNDS.statuses).map(raw => { const item = object(raw, 'Status catalog'); exact(item, ['entity', 'values', 'initial', 'terminal'], 'Status catalog'); const values = boundedArray(item.values, 'Status values', 24).map(entry => normalizeKey(entry, 'Status value')).sort(); assertUniqueNormalized(values, entry => entry, 'Status values'); const initial = normalizeKey(item.initial, 'Initial status'); const terminal = boundedArray(item.terminal, 'Terminal statuses', 8).map(entry => normalizeKey(entry, 'Terminal status')).sort(); if (!values.includes(initial) || terminal.some(entry => !values.includes(entry))) throw new SystemFactoryError('INVALID_STATUS', 'Status initial or terminal value is not declared.'); return { entity: normalizeKey(item.entity, 'Status entity'), values, initial, terminal } }).sort((a, b) => a.entity.localeCompare(b.entity))
  assertUniqueNormalized(statuses, item => item.entity, 'Status catalogs')
  if (statuses.some(item => !entityKeys.has(item.entity))) throw new SystemFactoryError('UNKNOWN_ENTITY', 'Status catalog references an unknown entity.')
  const statusMap = new Map(statuses.map(item => [item.entity, new Set(item.values)]))
  const workflows = boundedArray(value.workflows, 'Workflows', BOUNDS.workflows).map(raw => { const item = object(raw, 'Workflow'); exact(item, ['key', 'entity', 'transitions'], 'Workflow'); const entity = normalizeKey(item.entity, 'Workflow entity'); const transitions = boundedArray(item.transitions, 'Workflow transitions', BOUNDS.transitions).map(rawTransition => { const transition = object(rawTransition, 'Transition'); exact(transition, ['from', 'to', 'roles'], 'Transition'); const rolesForTransition = boundedArray(transition.roles, 'Transition roles', BOUNDS.roles).map(role => normalizeKey(role, 'Transition role')).sort(); assertUniqueNormalized(rolesForTransition, role => role, 'Transition roles'); return { from: normalizeKey(transition.from, 'Transition from'), to: normalizeKey(transition.to, 'Transition to'), roles: rolesForTransition } }).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)); if (!statusMap.has(entity) || transitions.some(transition => !statusMap.get(entity)!.has(transition.from) || !statusMap.get(entity)!.has(transition.to) || transition.roles.some(role => !roleKeys.has(role)))) throw new SystemFactoryError('INVALID_WORKFLOW', 'Workflow references an unknown status or role.'); return { key: normalizeKey(item.key, 'Workflow key'), entity, transitions } }).sort((a, b) => a.key.localeCompare(b.key))
  assertUniqueNormalized(workflows, item => item.key, 'Workflows')
  const views = boundedArray(value.views, 'Views', BOUNDS.views).map(raw => { const item = object(raw, 'View'); exact(item, ['key', 'entity', 'fields', 'kind'], 'View'); const entity = normalizeKey(item.entity, 'View entity'); const fields = boundedArray(item.fields, 'View fields', 24).map(field => normalizeKey(field, 'View field')); return { key: normalizeKey(item.key, 'View key'), entity, fields, kind: enumValue(item.kind, ['list', 'form', 'calendar', 'kanban'] as const, 'View kind') } }).sort((a, b) => a.key.localeCompare(b.key))
  assertUniqueNormalized(views, item => item.key, 'Views')
  for (const view of views) { const entity = entities.find(item => item.key === view.entity); if (!entity || view.fields.some(field => !entity.fields.some(candidate => candidate.key === field))) throw new SystemFactoryError('INVALID_VIEW', 'View references an unknown entity or field.') }
  const reports = boundedArray(value.reports, 'Reports', BOUNDS.reports).map(raw => { const item = object(raw, 'Report'); exact(item, ['key', 'label', 'entity', 'measure', 'field', 'timeWindowDays', 'limitations'], 'Report'); return { key: normalizeKey(item.key, 'Report key'), label: safeText(item.label, 'Report label', 120), entity: normalizeKey(item.entity, 'Report entity'), measure: enumValue(item.measure, ['count', 'sum', 'average'] as const, 'Report measure'), field: item.field === null ? null : normalizeKey(item.field, 'Report field'), timeWindowDays: item.timeWindowDays === null ? null : positiveInteger(item.timeWindowDays, 'Report time window', 1, 3660), limitations: boundedArray(item.limitations, 'Report limitations', 8).map(entry => safeText(entry, 'Report limitation', 300)) } }).sort((a, b) => a.key.localeCompare(b.key))
  assertUniqueNormalized(reports, item => item.key, 'Reports')
  for (const report of reports) { const entity = entities.find(item => item.key === report.entity); if (!entity || (report.field && !entity.fields.some(field => field.key === report.field))) throw new SystemFactoryError('INVALID_REPORT', 'Report references an unknown entity or field.') }
  const reportKeys = new Set(reports.map(item => item.key))
  const kpis = boundedArray(value.kpis, 'KPIs', BOUNDS.kpis).map(raw => { const item = object(raw, 'KPI'); exact(item, ['key', 'label', 'reportKey', 'denominatorReportKey', 'source', 'limitations'], 'KPI'); const result = { key: normalizeKey(item.key, 'KPI key'), label: safeText(item.label, 'KPI label', 120), reportKey: normalizeKey(item.reportKey, 'KPI report'), denominatorReportKey: item.denominatorReportKey === null ? null : normalizeKey(item.denominatorReportKey, 'KPI denominator'), source: enumValue(item.source, ['operational', 'aggregate_outcome'] as const, 'KPI source'), limitations: boundedArray(item.limitations, 'KPI limitations', 8).map(entry => safeText(entry, 'KPI limitation', 300)) }; if (!reportKeys.has(result.reportKey) || (result.denominatorReportKey && !reportKeys.has(result.denominatorReportKey))) throw new SystemFactoryError('INVALID_KPI', 'KPI references an unknown report.'); return result }).sort((a, b) => a.key.localeCompare(b.key))
  const notificationIntents = boundedArray(value.notificationIntents, 'Notification intents', BOUNDS.notifications).map(raw => { const item = object(raw, 'Notification'); exact(item, ['key', 'event', 'channel', 'recipientRole'], 'Notification'); const recipientRole = normalizeKey(item.recipientRole, 'Notification role'); if (!roleKeys.has(recipientRole)) throw new SystemFactoryError('INVALID_NOTIFICATION', 'Notification references an unknown role.'); return { key: normalizeKey(item.key, 'Notification key'), event: safeText(item.event, 'Notification event', 120), channel: enumValue(item.channel, ['email', 'in_app'] as const, 'Notification channel'), recipientRole } }).sort((a, b) => a.key.localeCompare(b.key))
  const integrationIntents = boundedArray(value.integrationIntents, 'Integration intents', BOUNDS.integrations).map(raw => { const item = object(raw, 'Integration'); exact(item, ['key', 'type', 'enabled', 'credentialReference', 'writeEnabled'], 'Integration'); const credentialReference = item.credentialReference === null ? null : normalizeText(item.credentialReference, 'Credential reference', 160); if (credentialReference && !/^(?:vault|secret|connection):[A-Za-z0-9][A-Za-z0-9:_-]{2,150}$/u.test(credentialReference)) throw new SystemFactoryError('CREDENTIAL_REFERENCE', 'Credential reference must be opaque.'); const enabled = bool(item.enabled, 'Integration enabled'); const writeEnabled = bool(item.writeEnabled, 'Integration writeEnabled'); if (writeEnabled && (!enabled || !credentialReference)) throw new SystemFactoryError('INTEGRATION_AUTHORITY', 'Integration writes require an enabled opaque credential reference.'); return { key: normalizeKey(item.key, 'Integration key'), type: enumValue(item.type, INTEGRATION_INTENTS, 'Integration type'), enabled, credentialReference, writeEnabled } }).sort((a, b) => a.key.localeCompare(b.key))
  assertUniqueNormalized(integrationIntents, item => item.key, 'Integration intents')
  const retentionInput = object(value.retention, 'Retention'); exact(retentionInput, ['operationalDays', 'auditDays', 'recoverableDeprovisionDays'], 'Retention')
  const auditInput = object(value.audit, 'Audit'); exact(auditInput, ['enabled', 'appendOnly', 'includeActor'], 'Audit')
  const previewInput = object(value.previewSeedPolicy, 'Preview seed policy'); exact(previewInput, ['syntheticOnly', 'fixtureCountPerEntity', 'containsProductionData'], 'Preview seed policy')
  const provisioningInput = object(value.provisioningPreferences, 'Provisioning preferences'); exact(provisioningInput, ['region', 'separateDatabase', 'deskAccess', 'backupBeforeUpgrade'], 'Provisioning preferences')
  const parentFingerprint = value.parentFingerprint === null ? null : normalizeText(value.parentFingerprint, 'Parent fingerprint', 64)
  if (parentFingerprint && !/^[a-f0-9]{64}$/u.test(parentFingerprint)) throw new SystemFactoryError('INVALID_FINGERPRINT', 'Parent fingerprint is invalid.')
  const draft: Omit<SystemSpec, 'fingerprint'> = {
    schemaVersion: SYSTEM_SPEC_VERSION, identity, businessType: safeText(value.businessType, 'Business type', 120), industry: safeText(value.industry, 'Industry', 120), systemTemplate, modules, entities, relationships, statuses, workflows, roles, views, reports, kpis, notificationIntents, integrationIntents,
    retention: { operationalDays: positiveInteger(retentionInput.operationalDays, 'Operational retention', 1, 3650), auditDays: positiveInteger(retentionInput.auditDays, 'Audit retention', 30, 3650), recoverableDeprovisionDays: positiveInteger(retentionInput.recoverableDeprovisionDays, 'Recoverable deprovision retention', 1, 365) },
    audit: { enabled: bool(auditInput.enabled, 'Audit enabled', true) as true, appendOnly: bool(auditInput.appendOnly, 'Audit appendOnly', true) as true, includeActor: bool(auditInput.includeActor, 'Audit includeActor', true) as true },
    previewSeedPolicy: { syntheticOnly: bool(previewInput.syntheticOnly, 'Preview syntheticOnly', true) as true, fixtureCountPerEntity: positiveInteger(previewInput.fixtureCountPerEntity, 'Preview fixture count', 0, 12), containsProductionData: bool(previewInput.containsProductionData, 'Preview production marker', false) as false },
    provisioningPreferences: { region: enumValue(provisioningInput.region, ['auto', 'ap-southeast'] as const, 'Provisioning region'), separateDatabase: bool(provisioningInput.separateDatabase, 'Separate database', true) as true, deskAccess: enumValue(provisioningInput.deskAccess, ['disabled', 'restricted'] as const, 'Desk access'), backupBeforeUpgrade: bool(provisioningInput.backupBeforeUpgrade, 'Backup before upgrade', true) as true },
    version: positiveInteger(value.version, 'Spec version', 1, 1_000_000), parentFingerprint,
  }
  validateTemplate(draft)
  const computed = fingerprint(draft)
  if (value.fingerprint !== '' && value.fingerprint !== computed) throw new SystemFactoryError('FINGERPRINT_MISMATCH', 'SystemSpec fingerprint does not match normalized content.', 409)
  return { ...draft, fingerprint: computed }
}

function validateTemplate(spec: Omit<SystemSpec, 'fingerprint'>): void {
  const template = TEMPLATE_CATALOG[spec.systemTemplate]
  const entityKeys = new Set(spec.entities.map(entity => entity.key))
  if (template.requiredEntities.some(key => !entityKeys.has(key))) throw new SystemFactoryError('TEMPLATE_REQUIREMENT', 'SystemSpec is missing a template-required entity.')
  if (spec.systemTemplate !== 'custom_bounded' && spec.entities.some(entity => !template.allowedEntities.includes(entity.key))) throw new SystemFactoryError('TEMPLATE_ENTITY', 'SystemSpec contains an entity outside the template catalog.')
  if (spec.modules.some(module => !template.capabilities.includes(module))) throw new SystemFactoryError('TEMPLATE_CAPABILITY', 'SystemSpec contains a capability outside the template catalog.')
  const allowedDocTypes = new Set(template.erpNextModules.flatMap(module => ERP_MODULE_DOCTYPES[module] || []))
  for (const entity of spec.entities) if (entity.kind === 'erpnext' && (!entity.erpNextDocType || !allowedDocTypes.has(entity.erpNextDocType))) throw new SystemFactoryError('DOCTYPE_ALLOWLIST', 'ERPNext DocType mapping is not allowlisted for this template.')
  for (const role of spec.roles) if (role.permissions.some(permission => permission.actions.includes('delete') && permission.entity === 'sales_order')) throw new SystemFactoryError('PERMISSION_ESCALATION', 'Generated roles cannot delete authoritative sales orders.')
}

export const ERP_MODULE_DOCTYPES: Record<string, string[]> = {
  CRM: ['Lead', 'Customer', 'Opportunity', 'Contact'], Selling: ['Customer', 'Opportunity', 'Sales Order'], Projects: ['Project', 'Task', 'Timesheet', 'Issue'], Stock: ['Item', 'Warehouse', 'Stock Entry'], Buying: ['Supplier', 'Purchase Order'], Education: ['Student', 'Course', 'Program Enrollment'],
}
