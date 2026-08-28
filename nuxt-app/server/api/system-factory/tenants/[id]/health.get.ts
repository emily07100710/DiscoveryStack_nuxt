import { getRouterParam } from 'h3'
import { systemFactoryOwnerContext } from '../../../../system-factory/http'
import { getDatabase } from '../../../../database'
import { and, eq } from 'drizzle-orm'
import { systemTenants } from '../../../../database/schema'

export default defineEventHandler(async event => {
  const { ownerUserId } = await systemFactoryOwnerContext(event); const tenantId = String(getRouterParam(event, 'id') || ''); const database = getDatabase(); if (!database) throw createError({ statusCode: 503, statusMessage: 'System Factory is temporarily unavailable.' })
  const [tenant] = await database.select({ state: systemTenants.state, healthyReceiptFingerprint: systemTenants.healthyReceiptFingerprint, updatedAt: systemTenants.updatedAt }).from(systemTenants).where(and(eq(systemTenants.ownerUserId, ownerUserId), eq(systemTenants.systemTenantId, tenantId))).limit(1); if (!tenant) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped system tenant was not found.' })
  return { health: { verified: Boolean(tenant.healthyReceiptFingerprint), state: tenant.state, receiptFingerprint: tenant.healthyReceiptFingerprint, observedAt: tenant.healthyReceiptFingerprint ? tenant.updatedAt : null }, claims: { liveProbePerformedByThisRequest: false } }
})
