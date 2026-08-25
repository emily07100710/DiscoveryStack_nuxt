import { sha256Hex, fingerprint, validateReceipt, validateRoutingPlan, type DeliveryReceipt, type Executor, type RouteIntent, type RoutingPlan } from './index'
import { guardTarget } from './target-guard'
import { normalizeMarkdownContent, normalizeOpaqueReference, normalizeTarget, type NormalizedTarget } from './normalization'

export const MULTI_CHANNEL_EXECUTOR_VERSION = 'publication-multi-channel-executor-v1'
export const MULTI_CHANNEL_MAX_RESPONSE_BYTES = 64_000
export const MULTI_CHANNEL_MAX_REASONS = 4

export type MultiChannelStatus = 'planned' | 'delivered' | 'blocked' | 'failed' | 'retry_wait'

export type MultiChannelAdapterInput = {
  route: RouteIntent
  target: NormalizedTarget
  content: string
  credential: string
  executorRunId: string
  attempt: number
  idempotencyKey: string
}

export type MultiChannelAdapterResult =
  | { status: 'delivered'; remote: { publicationId: string; contentHash: string; remoteRevision: string } }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; retryable: boolean; reason: string }
  | { status: 'retry_wait'; reason: string }

export type MultiChannelAdapter = (input: MultiChannelAdapterInput) => Promise<MultiChannelAdapterResult>
export type MultiChannelExecutorRegistry = Partial<Record<Executor, MultiChannelAdapter>>

export type MultiChannelHttpResponse = { status: number; headers?: Readonly<Record<string, string | undefined>>; text: () => Promise<string> }
export type MultiChannelHttpTransport = (url: string, init: { method: 'POST'; headers: Readonly<Record<string, string>>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<MultiChannelHttpResponse>
export type MultiChannelLocalTransport = (input: MultiChannelAdapterInput) => Promise<MultiChannelAdapterResult>
export type MultiChannelCredentialResolver = (credentialReference: string) => string | undefined | Promise<string | undefined>

export type MultiChannelDispatchInput = {
  plan: unknown
  routeId: string
  content: string
  idempotencyKey: string
  executorRunId: string
  attempt: number
  now: number
  mode: 'dry_run' | 'execute'
  knownReceipts?: readonly unknown[]
  registry?: MultiChannelExecutorRegistry
  resolveCredential?: MultiChannelCredentialResolver
}

export type MultiChannelFanoutResult = {
  status: 'delivered' | 'partial_failure' | 'retry_wait' | 'blocked'
  results: MultiChannelDispatchResult[]
  receipts: DeliveryReceipt[]
  reasons: string[]
}

export type MultiChannelDispatchResult = {
  status: MultiChannelStatus
  routeId: string
  executor: Executor | null
  attempt: number
  receipt: DeliveryReceipt | null
  receiptFingerprint: string | null
  replay: boolean
  collision: boolean
  reasons: string[]
}

function reason(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').replace(/\s+/gu, ' ').trim() : ''
  return (text || fallback).slice(0, 500)
}

function reasons(...values: unknown[]): string[] {
  return values.map(value => reason(value, 'dispatch blocked')).slice(0, MULTI_CHANNEL_MAX_REASONS)
}

function validAttempt(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10 }
function validEpoch(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

function targetForRoute(route: RouteIntent): { target: NormalizedTarget; reasons: string[] } {
  try {
    const target = normalizeTarget({ targetId: route.targetId, siteIdentity: route.siteIdentity, framework: route.framework, transport: route.transport, targetUrl: route.targetUrl, serviceReference: route.serviceReference, credentialReference: route.credentialReference, destinationPublicationIdentity: route.destinationPublicationIdentity, enabled: true })
    const guarded = guardTarget(target)
    return guarded.valid ? { target, reasons: [] } : { target, reasons: reasons(...guarded.reasonCodes) }
  } catch (error) {
    return { target: {} as NormalizedTarget, reasons: reasons(error, 'target normalization failed') }
  }
}

function receiptFor(plan: RoutingPlan, route: RouteIntent, input: MultiChannelDispatchInput, status: Exclude<MultiChannelStatus, 'planned'>): DeliveryReceipt {
  return {
    planFingerprint: plan.planFingerprint,
    routeId: route.routeId,
    targetId: route.targetId,
    siteIdentity: route.siteIdentity,
    sourcePublicationIdentity: route.sourcePublicationIdentity,
    destinationPublicationIdentity: route.destinationPublicationIdentity,
    draftId: route.draftId,
    reviewId: route.reviewId,
    evidenceSnapshotHash: route.evidenceSnapshotHash,
    contentHash: route.contentHash,
    executor: route.executor,
    executorAuthority: route.executorAuthority,
    executorRunId: normalizeOpaqueReference(input.executorRunId, 'executorRunId') as DeliveryReceipt['executorRunId'],
    attempt: input.attempt,
    status,
    plannedAt: plan.plannedAt,
    completedAt: input.now,
    occurredAt: input.now,
  }
}

function resultWithReceipt(plan: RoutingPlan, route: RouteIntent, input: MultiChannelDispatchInput, status: Exclude<MultiChannelStatus, 'planned'>, why: string[]): MultiChannelDispatchResult {
  const receipt = receiptFor(plan, route, input, status)
  const checked = validateReceipt(plan, receipt, input.knownReceipts || [])
  if (!checked.valid) return { status: 'blocked', routeId: route.routeId, executor: route.executor, attempt: input.attempt, receipt: null, receiptFingerprint: null, replay: false, collision: checked.collision, reasons: reasons(...checked.reasonCodes) }
  return { status, routeId: route.routeId, executor: route.executor, attempt: input.attempt, receipt, receiptFingerprint: checked.receiptFingerprint, replay: checked.replay, collision: checked.collision, reasons: reasons(...why) }
}

function dryRun(plan: RoutingPlan, route: RouteIntent, input: MultiChannelDispatchInput): MultiChannelDispatchResult {
  return { status: 'planned', routeId: route.routeId, executor: route.executor, attempt: input.attempt, receipt: null, receiptFingerprint: null, replay: false, collision: false, reasons: ['dry_run only: no credential was resolved and no external transport was called'] }
}

function buildPayload(input: MultiChannelAdapterInput): string {
  return JSON.stringify({
    version: MULTI_CHANNEL_EXECUTOR_VERSION,
    routeId: input.route.routeId,
    targetId: input.route.targetId,
    siteIdentity: input.route.siteIdentity,
    sourcePublicationIdentity: input.route.sourcePublicationIdentity,
    destinationPublicationIdentity: input.route.destinationPublicationIdentity,
    productionPlanId: input.route.productionPlanId,
    deliverableId: input.route.deliverableId,
    draftId: input.route.draftId,
    reviewId: input.route.reviewId,
    contentHash: input.route.contentHash,
    contentType: input.route.contentType,
    language: input.route.language,
    transport: input.route.transport,
    content: input.content,
    idempotencyKey: input.idempotencyKey,
    executorRunId: input.executorRunId,
    attempt: input.attempt,
  })
}

function responseReason(status: number): { status: 'blocked' | 'failed' | 'retry_wait'; retryable: boolean; reason: string } {
  if (status === 401 || status === 403) return { status: 'blocked', retryable: false, reason: 'remote authorization was rejected' }
  if (status === 409) return { status: 'blocked', retryable: false, reason: 'remote identity or idempotency conflict' }
  if (status === 408 || status === 429 || status >= 500) return { status: 'retry_wait', retryable: true, reason: `remote returned retryable HTTP status ${status}` }
  return { status: 'failed', retryable: false, reason: `remote returned non-success HTTP status ${status}` }
}

async function httpAdapter(input: MultiChannelAdapterInput, transport: MultiChannelHttpTransport, timeoutMs: number): Promise<MultiChannelAdapterResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await transport(input.target.targetUrl as string, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${input.credential}`, 'x-discoverystack-route-id': input.route.routeId, 'x-discoverystack-idempotency-key': input.idempotencyKey }, body: buildPayload(input) })
    if (response.status < 200 || response.status >= 300) {
      const mapped = responseReason(response.status)
      return mapped.status === 'retry_wait' ? { status: 'retry_wait', reason: mapped.reason } : { status: mapped.status, retryable: mapped.retryable, reason: mapped.reason }
    }
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MULTI_CHANNEL_MAX_RESPONSE_BYTES) return { status: 'blocked', reason: 'remote response exceeded the bounded response limit' }
    const payload = JSON.parse(body) as Record<string, unknown>
    const publicationId = payload.publicationId
    const contentHash = payload.contentHash
    const remoteRevision = payload.remoteRevision
    if (typeof publicationId !== 'string' || typeof contentHash !== 'string' || typeof remoteRevision !== 'string' || !publicationId || !contentHash || !remoteRevision) return { status: 'blocked', reason: 'remote response omitted required identity fields' }
    return { status: 'delivered', remote: { publicationId, contentHash, remoteRevision: remoteRevision.slice(0, 200) } }
  } catch (error) {
    if (controller.signal.aborted) return { status: 'retry_wait', reason: 'remote transport timed out' }
    return { status: 'failed', retryable: true, reason: reason(error, 'remote transport failed') }
  } finally { clearTimeout(timer) }
}

function externalAdapter(transport: MultiChannelHttpTransport, timeoutMs: number): MultiChannelAdapter {
  return async input => {
    if (!input.target.targetUrl) return { status: 'blocked', reason: 'external executor requires a guarded target URL' }
    return httpAdapter(input, transport, timeoutMs)
  }
}

export function createMultiChannelExecutorRegistry(options: { httpTransport?: MultiChannelHttpTransport; localTransport?: MultiChannelLocalTransport; timeoutMs?: number } = {}): MultiChannelExecutorRegistry {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs || 0) >= 1_000 && (options.timeoutMs || 0) <= 60_000 ? options.timeoutMs as number : 30_000
  const registry: MultiChannelExecutorRegistry = {}
  if (options.httpTransport) {
    registry.wordpress_rest = externalAdapter(options.httpTransport, timeoutMs)
    registry.geoflow_agent = externalAdapter(options.httpTransport, timeoutMs)
    registry.generic_http = externalAdapter(options.httpTransport, timeoutMs)
  }
  if (options.localTransport) registry.geoflow_local = options.localTransport
  return registry
}

export async function executeMultiChannelPublication(input: MultiChannelDispatchInput): Promise<MultiChannelDispatchResult> {
  const checkedPlan = validateRoutingPlan(input.plan)
  if (!checkedPlan.valid) return { status: 'blocked', routeId: input.routeId, executor: null, attempt: validAttempt(input.attempt) ? input.attempt : 1, receipt: null, receiptFingerprint: null, replay: false, collision: false, reasons: reasons(...checkedPlan.reasonCodes) }
  const plan = checkedPlan.plan
  const route = plan.routes.find(candidate => candidate.routeId === input.routeId)
  if (!route) return { status: 'blocked', routeId: input.routeId, executor: null, attempt: validAttempt(input.attempt) ? input.attempt : 1, receipt: null, receiptFingerprint: null, replay: false, collision: false, reasons: ['route is not present in the validated routing plan'] }
  if (!validAttempt(input.attempt) || !validEpoch(input.now) || input.now < plan.plannedAt) return { status: 'blocked', routeId: route.routeId, executor: route.executor, attempt: validAttempt(input.attempt) ? input.attempt : 1, receipt: null, receiptFingerprint: null, replay: false, collision: false, reasons: ['attempt or event time is invalid'] }
  let content: string
  try { content = normalizeMarkdownContent(input.content) } catch (error) { return { status: 'blocked', routeId: route.routeId, executor: route.executor, attempt: input.attempt, receipt: null, receiptFingerprint: null, replay: false, collision: false, reasons: reasons(error, 'content is invalid') } }
  if (sha256Hex(content) !== route.contentHash) return { status: 'blocked', routeId: route.routeId, executor: route.executor, attempt: input.attempt, receipt: null, receiptFingerprint: null, replay: false, collision: false, reasons: ['content hash does not match the approved route lineage'] }
  const targetResult = targetForRoute(route)
  if (targetResult.reasons.length) return { status: 'blocked', routeId: route.routeId, executor: route.executor, attempt: input.attempt, receipt: null, receiptFingerprint: null, replay: false, collision: false, reasons: targetResult.reasons }
  if (input.mode === 'dry_run') return dryRun(plan, route, input)
  const knownReplay = (input.knownReceipts || []).find(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const receipt = value as Record<string, unknown>
    return receipt.planFingerprint === plan.planFingerprint && receipt.routeId === route.routeId && receipt.attempt === input.attempt && receipt.executorRunId === input.executorRunId
  })
  if (knownReplay) {
    const replayed = resultWithReceipt(plan, route, input, 'delivered', ['replayed from the append-only receipt ledger; no executor was called'])
    return replayed.replay ? replayed : { ...replayed, status: 'blocked', reasons: ['stored receipt replay could not be validated'] }
  }
  const adapter = input.registry?.[route.executor]
  if (!adapter) return resultWithReceipt(plan, route, input, 'blocked', ['executor is not configured; no external transport was called'])
  if (typeof input.resolveCredential !== 'function') return resultWithReceipt(plan, route, input, 'blocked', ['server-side credential resolver is required; no external transport was called'])
  let credential: string | undefined
  try { credential = await input.resolveCredential(route.credentialReference) } catch { credential = undefined }
  if (!credential) return resultWithReceipt(plan, route, input, 'blocked', ['credential reference could not be resolved; no external transport was called'])
  let adapterResult: MultiChannelAdapterResult
  try {
    adapterResult = await adapter({ route, target: targetResult.target, content, credential, executorRunId: input.executorRunId, attempt: input.attempt, idempotencyKey: input.idempotencyKey })
  } catch (error) {
    return resultWithReceipt(plan, route, input, 'blocked', reasons(error, 'executor threw a sanitized failure'))
  }
  if (adapterResult.status === 'delivered') {
    if (adapterResult.remote.publicationId !== route.destinationPublicationIdentity || adapterResult.remote.contentHash !== route.contentHash || !adapterResult.remote.remoteRevision.trim()) return resultWithReceipt(plan, route, input, 'blocked', ['remote identity did not match the approved route lineage'])
    return resultWithReceipt(plan, route, input, 'delivered', ['remote identity, content hash, and revision were verified'])
  }
  const status: Exclude<MultiChannelStatus, 'planned' | 'delivered'> = adapterResult.status === 'retry_wait' ? 'retry_wait' : adapterResult.status === 'failed' ? 'failed' : 'blocked'
  return resultWithReceipt(plan, route, input, status, [adapterResult.reason])
}

export async function executeMultiChannelFanout(input: Omit<MultiChannelDispatchInput, 'routeId' | 'executorRunId' | 'idempotencyKey'> & { routeIds: readonly string[]; idempotencyKey: string; executorRunIdPrefix: string }): Promise<MultiChannelFanoutResult> {
  const results: MultiChannelDispatchResult[] = []
  for (const routeId of input.routeIds) {
    const suffix = sha256Hex(routeId).slice(0, 16)
    results.push(await executeMultiChannelPublication({ ...input, routeId, idempotencyKey: `${input.idempotencyKey}:${suffix}`.slice(0, 200), executorRunId: `ref-${input.executorRunIdPrefix}-${suffix}`.slice(0, 160) }))
  }
  const receipts = results.flatMap(result => result.receipt ? [result.receipt] : [])
  const delivered = results.filter(result => result.status === 'delivered').length
  const retryWait = results.some(result => result.status === 'retry_wait')
  const blocked = results.some(result => result.status === 'blocked' || result.status === 'failed')
  const status = delivered === results.length && results.length > 0 ? 'delivered' : delivered > 0 ? 'partial_failure' : retryWait ? 'retry_wait' : 'blocked'
  return { status, results, receipts, reasons: reasons(...results.flatMap(result => result.reasons)) }
}

export function receiptEventIdentity(receipt: DeliveryReceipt): { routeId: string; attempt: number; executorRunId: string; receiptFingerprint: string } {
  return { routeId: receipt.routeId, attempt: receipt.attempt, executorRunId: receipt.executorRunId, receiptFingerprint: fingerprint(receipt) }
}
