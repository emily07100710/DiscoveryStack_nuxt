import { describe, expect, it } from 'vitest'
import { SYSTEM_TEMPLATES } from '../server/system-factory/catalog'
import { compileSystemSpec, assertCompileReplay } from '../server/system-factory/compiler'
import { createGuidedSystemSpec, planSystemSpec } from '../server/system-factory/planner'
import { parseSystemSpec } from '../server/system-factory/system-spec'

function input(template: any = 'light_crm') {
  return { requirements: '需要受治理的客戶與工作流程系統。', businessType: 'service', industry: 'professional services', preferredTemplate: template, identity: { specId: `spec-${template}`, ownerId: 'owner:1', clientId: 'client:1', websiteId: 'website:1', managedSiteId: null, systemTenantId: null, locale: 'zh-hant' as const, timezone: 'Asia/Taipei', currency: 'TWD' } }
}

describe('SystemSpec strict schema and deterministic compiler', () => {
  it.each(SYSTEM_TEMPLATES)('builds and compiles allowlisted %s template', template => {
    const spec = createGuidedSystemSpec(input(template)); const first = compileSystemSpec(spec); const second = compileSystemSpec(structuredClone(spec))
    expect(first).toEqual(second); expect(first.planFingerprint).toMatch(/^[a-f0-9]{64}$/u); expect(first.units.map(unit => `${unit.kind}:${unit.key}`)).toEqual([...first.units].map(unit => `${unit.kind}:${unit.key}`))
  })

  it.each([null, [], 'text', 3, { schemaVersion: 'system-spec-v1' }])('rejects malformed, null, or incomplete input %#', value => { expect(() => parseSystemSpec(value)).toThrow() })

  it('rejects NFKC collisions, duplicates, reserved DocTypes and bounds', () => {
    const duplicate: any = createGuidedSystemSpec(input()); const lead = duplicate.entities.find((entity: any) => entity.key === 'lead'); lead.fields.push({ ...lead.fields[0], key: 'lead＿name' }); duplicate.fingerprint = ''
    expect(() => parseSystemSpec(duplicate)).toThrow(/normalized duplicate/i)
    const duplicateEntity: any = createGuidedSystemSpec(input()); duplicateEntity.entities.push(structuredClone(duplicateEntity.entities[0])); duplicateEntity.fingerprint = ''
    expect(() => parseSystemSpec(duplicateEntity)).toThrow(/normalized duplicate/i)
    const reserved: any = createGuidedSystemSpec(input('custom_bounded')); reserved.entities = [{ key: 'user', label: 'User', kind: 'erpnext', erpNextDocType: 'User', fields: [] }]; reserved.fingerprint = ''
    expect(() => compileSystemSpec(reserved)).toThrow()
    const bounded: any = createGuidedSystemSpec(input()); bounded.entities = Array.from({ length: 25 }, (_, index) => ({ key: `entity_${index}`, label: `Entity ${index}`, kind: 'custom', erpNextDocType: null, fields: [] })); bounded.fingerprint = ''
    expect(() => parseSystemSpec(bounded)).toThrow(/bound/i)
  })

  it.each(['<script>alert(1)</script>', '../private/secret', 'DROP TABLE users', 'bash -lc whoami', 'eval(payload)'])('rejects dangerous code, path, SQL or command content', dangerous => {
    const spec: any = createGuidedSystemSpec(input()); spec.businessType = dangerous; spec.fingerprint = ''; expect(() => parseSystemSpec(spec)).toThrow(/executable|path/i)
  })

  it('rejects unknown capability and role permission escalation', () => {
    const capability: any = createGuidedSystemSpec(input()); capability.modules.push('root_shell'); capability.fingerprint = ''; expect(() => parseSystemSpec(capability)).toThrow(/allowlisted/i)
    const permission: any = createGuidedSystemSpec(input('inventory_sales')); const role = permission.roles[0]; role.permissions.find((item: any) => item.entity === 'sales_order').actions.push('delete'); permission.fingerprint = ''; expect(() => parseSystemSpec(permission)).toThrow(/delete/i)
  })

  it('enforces replay and payload collision semantics', () => {
    const spec = createGuidedSystemSpec(input()); const index = new Map<string, string>(); const first = assertCompileReplay(null, 'compile-key-0001', spec, index); expect(assertCompileReplay(first, 'compile-key-0001', spec, index)).toEqual(first)
    const changed: any = structuredClone(spec); changed.businessType = 'changed'; changed.fingerprint = ''
    expect(() => assertCompileReplay(first, 'compile-key-0001', changed, index)).toThrow(/idempotency/i)
  })

  it('revalidates provider output and uses truthful deterministic fallback', async () => {
    const fallback = await planSystemSpec(input()); expect(fallback.mode).toBe('guided_deterministic')
    const provider = { plan: async () => ({ ...fallback.spec, fingerprint: '0'.repeat(64), roles: fallback.spec.roles.map(role => ({ ...role, permissions: role.permissions.map(permission => ({ ...permission, actions: [...permission.actions, 'delete'] })) })) }) }
    await expect(planSystemSpec(input(), provider)).rejects.toThrow()
  })
})
