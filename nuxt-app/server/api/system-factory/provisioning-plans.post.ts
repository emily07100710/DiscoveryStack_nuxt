import { strictSystemFactoryBody, systemFactoryOwnerContext } from '../../system-factory/http'
import { planSystemProvisioning } from '../../system-factory/service'

export default defineEventHandler(async event => {
  const { ownerUserId } = await systemFactoryOwnerContext(event, true); const body = await strictSystemFactoryBody(event, ['systemSpecId', 'managedSiteDraftOrderId', 'managedSitePaymentEventId', 'idempotencyKey'])
  return planSystemProvisioning(ownerUserId, body as any)
})
