import { getRouterParam } from 'h3'
import { and, desc, eq } from 'drizzle-orm'
import { getDatabase } from '../../../../database'
import { systemEvents, systemReceipts, systemTenants, systemUpgradeReceipts } from '../../../../database/schema'
import { boundedPage, systemFactoryOwnerContext } from '../../../../system-factory/http'
import { getQuery } from 'h3'

export default defineEventHandler(async event => {
  const { ownerUserId } = await systemFactoryOwnerContext(event); const tenantId = String(getRouterParam(event, 'id') || ''); const page = boundedPage(getQuery(event)); const database = getDatabase(); if (!database) throw createError({ statusCode: 503, statusMessage: 'System Factory is temporarily unavailable.' })
  const [tenant] = await database.select({ id: systemTenants.id }).from(systemTenants).where(and(eq(systemTenants.ownerUserId, ownerUserId), eq(systemTenants.systemTenantId, tenantId))).limit(1); if (!tenant) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped system tenant was not found.' })
  const [events, receipts, upgradeReceipts] = await Promise.all([database.select().from(systemEvents).where(and(eq(systemEvents.ownerUserId, ownerUserId), eq(systemEvents.systemTenantId, tenant.id))).orderBy(desc(systemEvents.createdAt)).limit(page.limit).offset(page.offset), database.select().from(systemReceipts).where(and(eq(systemReceipts.ownerUserId, ownerUserId), eq(systemReceipts.systemTenantId, tenant.id))).orderBy(desc(systemReceipts.createdAt)).limit(page.limit).offset(page.offset), database.select().from(systemUpgradeReceipts).where(and(eq(systemUpgradeReceipts.ownerUserId, ownerUserId), eq(systemUpgradeReceipts.systemTenantId, tenant.id))).orderBy(desc(systemUpgradeReceipts.createdAt)).limit(page.limit).offset(page.offset)])
  return { events, receipts, upgradeReceipts, pagination: page }
})
