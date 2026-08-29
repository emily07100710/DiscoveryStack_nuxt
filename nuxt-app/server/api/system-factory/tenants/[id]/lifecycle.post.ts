import { getRouterParam } from 'h3'
import { strictSystemFactoryBody, systemFactoryOwnerContext } from '../../../../system-factory/http'
import { requestSystemLifecycle } from '../../../../system-factory/service'

export default defineEventHandler(async event => { const { ownerUserId } = await systemFactoryOwnerContext(event, true); const tenantId = String(getRouterParam(event, 'id') || ''); const body = await strictSystemFactoryBody(event, ['action', 'idempotencyKey']); return requestSystemLifecycle(ownerUserId, tenantId, body as any) })
