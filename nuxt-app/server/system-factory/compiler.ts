import { COMPILED_PLAN_VERSION, RESERVED_DOCTYPES, SYSTEM_COMPILER_VERSION, TEMPLATE_CATALOG } from './catalog'
import { canonicalJson, fingerprint, SystemFactoryError } from './canonical'
import { parseSystemSpec, type SystemSpec } from './system-spec'

export type CompiledUnit =
  | { kind: 'module'; key: string; erpNextModule: string }
  | { kind: 'doctype'; key: string; source: string; custom: boolean; fields: SystemSpec['entities'][number]['fields'] }
  | { kind: 'workflow'; key: string; entity: string; transitions: SystemSpec['workflows'][number]['transitions'] }
  | { kind: 'role'; key: string; permissions: SystemSpec['roles'][number]['permissions'] }
  | { kind: 'report'; key: string; definition: SystemSpec['reports'][number] }
  | { kind: 'integration_intent'; key: string; definition: SystemSpec['integrationIntents'][number] }

export type CompiledSystemPlan = { schemaVersion: typeof COMPILED_PLAN_VERSION; compilerVersion: typeof SYSTEM_COMPILER_VERSION; specId: string; specVersion: number; specFingerprint: string; parentFingerprint: string | null; tenantBinding: SystemSpec['identity']; units: CompiledUnit[]; canonicalSpecJson: string; planFingerprint: string }

export function compileSystemSpec(input: unknown): CompiledSystemPlan {
  const spec = parseSystemSpec(input)
  const template = TEMPLATE_CATALOG[spec.systemTemplate]
  const units: CompiledUnit[] = []
  for (const erpNextModule of [...template.erpNextModules].sort()) units.push({ kind: 'module', key: erpNextModule.toLocaleLowerCase('en-US').replace(/\s+/gu, '_'), erpNextModule })
  for (const entity of spec.entities) {
    const source = entity.erpNextDocType || `DiscoveryStack ${entity.label}`
    if (RESERVED_DOCTYPES.has(source.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, '_'))) throw new SystemFactoryError('RESERVED_DOCTYPE', 'SystemSpec cannot target a reserved/system DocType.')
    units.push({ kind: 'doctype', key: entity.key, source, custom: entity.kind === 'custom', fields: entity.fields })
  }
  for (const workflow of spec.workflows) units.push({ kind: 'workflow', key: workflow.key, entity: workflow.entity, transitions: workflow.transitions })
  for (const role of spec.roles) units.push({ kind: 'role', key: role.key, permissions: role.permissions })
  for (const report of spec.reports) units.push({ kind: 'report', key: report.key, definition: report })
  for (const integration of spec.integrationIntents) units.push({ kind: 'integration_intent', key: integration.key, definition: integration })
  const order: Record<CompiledUnit['kind'], number> = { module: 1, doctype: 2, role: 3, workflow: 4, report: 5, integration_intent: 6 }
  units.sort((left, right) => order[left.kind] - order[right.kind] || left.key.localeCompare(right.key))
  const draft = { schemaVersion: COMPILED_PLAN_VERSION, compilerVersion: SYSTEM_COMPILER_VERSION, specId: spec.identity.specId, specVersion: spec.version, specFingerprint: spec.fingerprint, parentFingerprint: spec.parentFingerprint, tenantBinding: spec.identity, units, canonicalSpecJson: canonicalJson(spec) }
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
