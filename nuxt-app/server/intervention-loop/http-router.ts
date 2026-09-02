import { createError, getQuery, getRouterParam, setHeader, setResponseStatus, type H3Event } from 'h3'
import { attachInterventionToExperiment, concludeExperiment, createExperiment, listExperiments } from './experiments'
import { exportInterventionOutcomeDataset } from './export'
import { assertSameOriginMutation, positiveId, readInterventionBody, requireInterventionOwner, routeError, setInterventionPrivateApiHeaders } from './http'
import { enqueueRefreshManually, getRefreshPolicy, listRefreshQueue, updateRefreshPolicy, updateRefreshQueueItem } from './refresh-queue'
import { assessIntervention, cancelIntervention, checkDeploymentNow, checkRecrawl, confirmDeploymentManually, confirmRecrawlManually, getIntervention, listInterventions, measureIntervention, pullMetrics, recordManualMeasurement, registerIntervention } from './service'
import { runInterventionLoopTick } from './tick'
import { interventionStatuses } from './types'

type RouteMethod = 'GET' | 'POST'
type RouteContext = { event: H3Event, ownerUserId: number, params: string[], body: Record<string, unknown> }
type InterventionRoute = { method: RouteMethod, pattern: string[], handle: (context: RouteContext) => Promise<unknown> }
type ActionHandler = (ownerUserId: number, id: number, body: Record<string, unknown>) => Promise<unknown>

const interventionActions = new Map<string, ActionHandler>([
  ['assess', (ownerUserId, interventionId) => assessIntervention(ownerUserId, interventionId)],
  ['cancel', (ownerUserId, interventionId, body) => cancelIntervention(ownerUserId, interventionId, body)],
  ['check-deployment', (ownerUserId, interventionId) => checkDeploymentNow(ownerUserId, interventionId)],
  ['check-recrawl', (ownerUserId, interventionId) => checkRecrawl(ownerUserId, interventionId, undefined, { automatic: false })],
  ['confirm-deployment', (ownerUserId, interventionId, body) => confirmDeploymentManually(ownerUserId, interventionId, body)],
  ['confirm-recrawl', (ownerUserId, interventionId, body) => confirmRecrawlManually(ownerUserId, interventionId, body)],
  ['measure', (ownerUserId, interventionId) => measureIntervention(ownerUserId, interventionId)],
  ['measurements', (ownerUserId, interventionId, body) => recordManualMeasurement(ownerUserId, interventionId, body)],
  ['pull-metrics', (ownerUserId, interventionId) => pullMetrics(ownerUserId, interventionId, undefined, { reason: 'owner_request' })],
])

const experimentActions = new Map<string, ActionHandler>([
  ['attach', (ownerUserId, experimentId, body) => attachInterventionToExperiment(ownerUserId, experimentId, body)],
  ['conclude', (ownerUserId, experimentId) => concludeExperiment(ownerUserId, experimentId)],
])

function action(actions: Map<string, ActionHandler>, name: string | undefined, statusMessage: string): ActionHandler {
  const handler = actions.get(name || '')
  if (!handler) throw createError({ statusCode: 404, statusMessage })
  return handler
}

function created<T extends { replayed: boolean }>(event: H3Event, result: T): T {
  setResponseStatus(event, result.replayed ? 200 : 201)
  return result
}

// Static patterns are listed before parameterised ones so `/export` never resolves as an id.
// The collection itself is served as `list`/`register` rather than the bare `/api/interventions`:
// radix3 does not match a bare path against `/api/interventions/**`, so a second route file would be
// needed, and this app is at the typed-route-map depth limit (INTERVENTION_LOOP_RUNTIME_V1.md §路由清單).
const routes: InterventionRoute[] = [
  { method: 'GET', pattern: ['export'], handle: async ({ event, ownerUserId }) => { setHeader(event, 'content-disposition', 'attachment; filename="intervention-outcome-dataset.json"'); return exportInterventionOutcomeDataset(ownerUserId) } },
  { method: 'GET', pattern: ['experiments'], handle: async ({ ownerUserId }) => ({ experiments: await listExperiments(ownerUserId) }) },
  { method: 'POST', pattern: ['experiments'], handle: async ({ event, ownerUserId, body }) => created(event, await createExperiment(ownerUserId, body)) },
  { method: 'POST', pattern: ['experiments', ':id', ':action'], handle: ({ ownerUserId, params, body }) => action(experimentActions, params[1], 'Unknown experiment action.')(ownerUserId, positiveId(params[0]), body) },
  { method: 'GET', pattern: ['list'], handle: async ({ event, ownerUserId }) => {
    const query = getQuery(event)
    const status = query.status === undefined ? undefined : String(query.status)
    if (status && !interventionStatuses.includes(status as never)) throw createError({ statusCode: 422, statusMessage: 'status is invalid.' })
    const limit = query.limit === undefined ? undefined : Number(query.limit)
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) throw createError({ statusCode: 422, statusMessage: 'limit is invalid.' })
    const [interventions, refreshPolicy, queue] = await Promise.all([listInterventions(ownerUserId, { status: status as never, limit }), getRefreshPolicy(ownerUserId), listRefreshQueue(ownerUserId, { status: 'open' })])
    return { interventions, refreshPolicy, openRefreshCount: queue.length, limitations: ['owner_scoped'] }
  } },
  { method: 'GET', pattern: ['refresh-policy'], handle: ({ ownerUserId }) => getRefreshPolicy(ownerUserId) },
  { method: 'POST', pattern: ['refresh-policy'], handle: ({ ownerUserId, body }) => updateRefreshPolicy(ownerUserId, body) },
  { method: 'GET', pattern: ['refresh-queue'], handle: async ({ event, ownerUserId }) => { const status = getQuery(event).status; if (status !== undefined && !['open', 'in_progress', 'done', 'dismissed'].includes(String(status))) throw createError({ statusCode: 422, statusMessage: 'status is invalid.' }); return { items: await listRefreshQueue(ownerUserId, { status: status as never }) } } },
  { method: 'POST', pattern: ['refresh-queue'], handle: async ({ event, ownerUserId, body }) => created(event, await enqueueRefreshManually(ownerUserId, body)) },
  { method: 'POST', pattern: ['refresh-queue', ':id', 'status'], handle: ({ ownerUserId, params, body }) => updateRefreshQueueItem(ownerUserId, positiveId(params[0]), body) },
  { method: 'POST', pattern: ['register'], handle: async ({ event, ownerUserId, body }) => created(event, await registerIntervention(ownerUserId, body)) },
  { method: 'POST', pattern: ['tick'], handle: ({ ownerUserId }) => runInterventionLoopTick(ownerUserId, undefined, { maxInterventions: 50 }) },
  { method: 'GET', pattern: [':id'], handle: async ({ ownerUserId, params }) => ({ ...await getIntervention(ownerUserId, positiveId(params[0])), limitations: ['owner_scoped'] }) },
  { method: 'POST', pattern: [':id', ':action'], handle: ({ ownerUserId, params, body }) => action(interventionActions, params[1], 'Unknown intervention action.')(ownerUserId, positiveId(params[0]), body) },
]

export function matchInterventionRoute(method: string, segments: string[]): { route: InterventionRoute, params: string[] } | null {
  for (const route of routes) {
    if (route.method !== method || route.pattern.length !== segments.length) continue
    const params: string[] = []
    let matched = true
    for (let index = 0; index < route.pattern.length; index += 1) {
      const expected = route.pattern[index] || ''
      const actual = segments[index] || ''
      if (expected.startsWith(':')) params.push(actual)
      else if (expected !== actual) { matched = false; break }
    }
    if (matched) return { route, params }
  }
  return null
}

export async function handleInterventionRoute(event: H3Event) {
  setInterventionPrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireInterventionOwner(event)
    const segments = (getRouterParam(event, 'path') || '').split('/').filter(Boolean)
    const matched = matchInterventionRoute(event.method.toUpperCase(), segments)
    if (!matched) throw createError({ statusCode: 404, statusMessage: 'Unknown intervention route.' })
    let body: Record<string, unknown> = {}
    if (matched.route.method === 'POST') { assertSameOriginMutation(event); body = await readInterventionBody(event) }
    return await matched.route.handle({ event, ownerUserId, params: matched.params, body })
  } catch (error) { return routeError(error) }
}
