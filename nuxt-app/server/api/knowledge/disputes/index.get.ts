import { getQuery } from 'h3'
import { getKnowledgeService, requireKnowledgeOwner, routeError, setKnowledgePrivateApiHeaders } from '../_helpers'
export default defineEventHandler(async event => { setKnowledgePrivateApiHeaders(event); try { const { ownerUserId } = await requireKnowledgeOwner(event); const status = getQuery(event).status; return { status: 'success', disputes: await getKnowledgeService(ownerUserId).listDisputes(typeof status === 'string' ? { status: status as 'open' | 'resolved' } : {}) } } catch (error) { return routeError(error) } })
