import { getQuery } from 'h3'
import { getKnowledgeService, requireKnowledgeOwner, routeError, setKnowledgePrivateApiHeaders } from '../_helpers'
export default defineEventHandler(async event => { setKnowledgePrivateApiHeaders(event); try { const { ownerUserId } = await requireKnowledgeOwner(event); const status = getQuery(event).status; return { status: 'success', claims: await getKnowledgeService(ownerUserId).listClaims(typeof status === 'string' ? { status: status as never } : {}) } } catch (error) { return routeError(error) } })
