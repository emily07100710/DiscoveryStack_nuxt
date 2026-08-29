import { describe, expect, it } from 'vitest'
import { compileSystemSpec } from '../server/system-factory/compiler'
import { createGuidedSystemSpec } from '../server/system-factory/planner'
import { DrizzleProvisioningRepository } from '../server/system-factory/provisioning-repository-drizzle'
import { MemoryProvisioningRepository, mockedProvisioningContext, runProvisioningTick } from '../server/system-factory/provisioning-scheduler'
import { createMockSystemFactoryProvisioner } from '../server/system-factory/provisioner'
import { testRuntimeAuthority } from '../server/system-factory/runtime-authority'

const authority = testRuntimeAuthority('database-performance')
function plan() { return compileSystemSpec(createGuidedSystemSpec({ requirements: '建立一個受治理且可供服務團隊使用的預約管理系統。', businessType: 'service', industry: 'wellness', preferredTemplate: 'appointment_booking', identity: { specId: 'spec-db', ownerId: 'owner:1', clientId: 'client:1', websiteId: 'website:1', managedSiteId: 'managed-site:1', systemTenantId: 'system-tenant-1', locale: 'zh-hant', timezone: 'Asia/Taipei', currency: 'TWD' } })) }

describe('System Factory database selection and round-trip bounds', () => {
  it('selects earliest eligible run per tenant in one database round trip', async () => {
    let selects = 0; const stages: string[] = []
    const builder: any = { from() { stages.push('from'); return this }, where() { stages.push('where'); return this }, groupBy() { stages.push('groupBy'); return this }, orderBy() { stages.push('orderBy'); return this }, async limit() { stages.push('limit'); return [{ runRowId: 3, tenantRowId: 10 }, { runRowId: 9, tenantRowId: 11 }] } }
    const database: any = { select() { selects++; return builder } }
    const repository = new DrizzleProvisioningRepository(database, authority)
    await expect(repository.listEligible(new Date('2030-01-01T00:00:00Z'), 20)).resolves.toEqual([{ runRowId: 3, tenantRowId: 10 }, { runRowId: 9, tenantRowId: 11 }])
    expect(selects).toBe(1); expect(stages).toEqual(['from', 'where', 'groupBy', 'orderBy', 'limit'])
  })

  it('reads completed operations once per claim regardless of step count', async () => {
    const repository = new MemoryProvisioningRepository([mockedProvisioningContext({ compiledPlan: plan(), authority })]); let completedReads = 0; const original = repository.completedOperations.bind(repository); repository.completedOperations = async claim => { completedReads++; return original(claim) }
    const result = await runProvisioningTick({ repository, provisioner: createMockSystemFactoryProvisioner(), workerId: 'worker:db-roundtrip' })
    expect(result).toMatchObject({ executed: 7, completed: 1 }); expect(completedReads).toBe(1)
  })
})
