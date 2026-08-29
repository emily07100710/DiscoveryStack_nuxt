import { getRouterParam } from 'h3'
import { strictSystemFactoryBody, systemFactoryOwnerContext } from '../../../../system-factory/http'
import { planSystemUpgrade } from '../../../../system-factory/service'

export default defineEventHandler(async event => {
  const { ownerUserId } = await systemFactoryOwnerContext(event, true); const tenantId = String(getRouterParam(event, 'id') || ''); const body = await strictSystemFactoryBody(event, ['toVersionLockHash', 'idempotencyKey'])
  return planSystemUpgrade(ownerUserId, tenantId, body as any)
})
