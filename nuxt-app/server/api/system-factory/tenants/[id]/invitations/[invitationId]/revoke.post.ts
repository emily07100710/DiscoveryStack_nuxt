import { getRouterParam } from 'h3'
import { strictSystemFactoryBody, systemFactoryOwnerContext } from '../../../../../../system-factory/http'
import { revokeSystemAdminInvitation } from '../../../../../../system-factory/service'

export default defineEventHandler(async event => { const { ownerUserId } = await systemFactoryOwnerContext(event, true); await strictSystemFactoryBody(event, []); return revokeSystemAdminInvitation(ownerUserId, String(getRouterParam(event, 'id') || ''), String(getRouterParam(event, 'invitationId') || '')) })
