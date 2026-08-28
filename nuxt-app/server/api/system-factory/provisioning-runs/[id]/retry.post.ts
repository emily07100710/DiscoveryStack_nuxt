import { getRouterParam } from 'h3'
import { strictSystemFactoryBody, systemFactoryOwnerContext } from '../../../../system-factory/http'
import { retrySystemProvisioning } from '../../../../system-factory/service'

export default defineEventHandler(async event => { const { ownerUserId } = await systemFactoryOwnerContext(event, true); await strictSystemFactoryBody(event, []); return retrySystemProvisioning(ownerUserId, String(getRouterParam(event, 'id') || '')) })
