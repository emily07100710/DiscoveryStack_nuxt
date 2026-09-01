import { getQuery } from 'h3'
import { getKnowledgeService, requireKnowledgeOwner, routeError, setKnowledgePrivateApiHeaders } from './_helpers'
export default defineEventHandler(async event => { setKnowledgePrivateApiHeaders(event); try { const { ownerUserId } = await requireKnowledgeOwner(event); const status = getQuery(event).status; return { status: 'success', mergeCandidates: await getKnowledgeService(ownerUserId).listMergeCandidates(typeof status === 'string' ? { status: status as 'pending' | 'approved' | 'rejected' } : {}) } } catch (error) { return routeError(error) } })
