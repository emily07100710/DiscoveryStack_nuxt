import { describe, expect, it, vi } from 'vitest'
import { normalizeFirstPartyDraftReceipt, type FirstPartyDraftReceipt } from '../server/first-party-publishing/draft-receipt'
import {
  RouteEventLedger,
  aggregateEvents,
  fingerprint,
  validateReceipt,
  validateReceiptHistory,
  validateRetry,
  type DeliveryReceipt,
} from '../server/publication-routing'
import { executeMultiChannelFanout, executeMultiChannelPublication, type MultiChannelAdapter } from '../server/publication-routing/multi-channel-executors'
import { FIXTURE_CONTENT, FIXTURE_NOW, LEGAL_TARGETS, makeEvent, makePlan, makeReceipt, makeResultEvent, makeTarget, opaque } from './fixtures/publication-routing/fixtures'

const NEXT_SIGNED_TARGET = makeTarget({
  targetId: 'target-nextjs-signed-001',
  siteIdentity: 'site-nextjs-signed-001',
  framework: 'nextjs',
  transport: 'first_party_signed_api',
  targetUrl: 'https://nextjs-api.routing.discoverystack.dev',
  credentialReference: opaque('ref-hmac-nextjs-001'),
  destinationPublicationIdentity: 'destination-nextjs-001',
})

function nextPlan() {
  return makePlan([NEXT_SIGNED_TARGET])
}

function receiptFor(plan: ReturnType<typeof makePlan>, index = 0, draftOverrides: Partial<FirstPartyDraftReceipt> = {}): DeliveryReceipt {
  const route = plan.routes[index]!
  const draftReceipt: FirstPartyDraftReceipt = {
    status: 'draft_received',
    published: false,
    receiptScope: 'draft_ingest_outcome',
    receiptIsCurrentState: false,
    publicationId: route.destinationPublicationIdentity,
    contentHash: route.contentHash,
    postId: 'post-001',
    postVersion: 1,
    replayed: false,
    ...draftOverrides,
  }
  return makeReceipt(plan, route, { status: 'draft_received', draftReceipt })
}

function adapterFor(receipt: unknown) {
  return vi.fn(async () => ({ status: 'draft_received' as const, receipt: receipt as FirstPartyDraftReceipt }))
}

function executeInput(plan = nextPlan()) {
  const route = plan.routes[0]!
  return {
    plan,
    routeId: route.routeId,
    content: FIXTURE_CONTENT,
    idempotencyKey: 'draft-route-key',
    executorRunId: 'ref-draft-run-001',
    attempt: 1,
    now: FIXTURE_NOW + 100,
    mode: 'execute' as const,
    resolveCredential: async () => 'synthetic-test-credential',
  }
}

describe('first-party draft receipt in publication routing', () => {
  it('rejects duplicate fanout routes before any credential lookup or remote write', async () => {
    const plan = nextPlan(), route = plan.routes[0]!
    const adapter = adapterFor(receiptFor(plan).draftReceipt), resolveCredential = vi.fn(async () => 'synthetic-test-credential')
    const result = await executeMultiChannelFanout({ ...executeInput(plan), routeIds: [route.routeId, route.routeId], executorRunIdPrefix: 'draft-run', registry: { first_party_signed_api: adapter }, resolveCredential })
    expect(result).toMatchObject({ status: 'blocked', results: [], receipts: [] })
    expect(adapter).not.toHaveBeenCalled()
    expect(resolveCredential).not.toHaveBeenCalled()
  })
  it('validates and normalizes the exact nine-field receipt only for a matching Next.js signed route', () => {
    const plan = nextPlan()
    const receipt = receiptFor(plan)
    const checked = validateReceipt(plan, receipt)

    expect(checked.valid).toBe(true)
    expect(checked.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(validateReceiptHistory(plan, [receipt])).toMatchObject({ valid: true, receipts: [receipt] })
    expect(Object.keys(receipt.draftReceipt || {}).sort()).toEqual([
      'contentHash', 'postId', 'postVersion', 'publicationId', 'published', 'receiptIsCurrentState', 'receiptScope', 'replayed', 'status',
    ])
    expect(normalizeFirstPartyDraftReceipt({ ...receipt.draftReceipt!, publicUrl: 'https://public.invalid/article' })).toBeNull()
    expect(validateReceipt(plan, { ...receipt, draftReceipt: { ...receipt.draftReceipt!, publicUrl: 'https://public.invalid/article' } }).valid).toBe(false)
    expect(validateReceipt(plan, { ...receipt, draftReceipt: { ...receipt.draftReceipt!, published: true } }).valid).toBe(false)
    expect(validateReceipt(plan, { ...receipt, draftReceipt: { ...receipt.draftReceipt!, publicationId: 'other-publication' } }).valid).toBe(false)
    expect(validateReceipt(plan, { ...receipt, draftReceipt: { ...receipt.draftReceipt!, contentHash: 'f'.repeat(64) } }).valid).toBe(false)
    expect(validateReceipt(plan, { ...receipt, draftReceipt: undefined }).valid).toBe(false)
  })

  it('forbids draft receipt data on other statuses and on non-Next.js first-party routes', () => {
    const plan = nextPlan()
    const draftReceipt = receiptFor(plan).draftReceipt!
    const delivered = makeReceipt(plan, plan.routes[0]!, { draftReceipt } as Partial<DeliveryReceipt>)
    expect(validateReceipt(plan, delivered).valid).toBe(false)

    const astroPlan = makePlan([LEGAL_TARGETS.astroSigned])
    const astroReceipt = makeReceipt(astroPlan, astroPlan.routes[0]!, { status: 'draft_received', draftReceipt })
    expect(validateReceipt(astroPlan, astroReceipt).valid).toBe(false)
  })

  it('records draft_received as terminal and blocks any later retry attempt', () => {
    const plan = nextPlan()
    const first = receiptFor(plan)
    const second = makeReceipt(plan, plan.routes[0]!, { status: 'failed', attempt: 2, executorRunId: opaque('ref-second-attempt'), plannedAt: plan.plannedAt, completedAt: first.occurredAt + 1, occurredAt: first.occurredAt + 2 })
    const retry = validateRetry(plan, first, second, [first])
    expect(retry.valid).toBe(false)
    expect(retry.reasonCodes).toContain('RETRY_PREVIOUS_STATUS_FORBIDDEN')

    const ledger = new RouteEventLedger(plan)
    expect(ledger.append(makeEvent(plan, plan.routes[0]!)).accepted).toBe(true)
    const firstResult = makeResultEvent(plan, first, 2)
    expect(ledger.append(firstResult, first).accepted).toBe(true)
    expect(ledger.append(makeResultEvent(plan, second, 3), second).accepted).toBe(false)
    expect(ledger.eventsFor(plan.routes[0]!.routeId)).toHaveLength(2)
  })

  it('aggregates all delivered/draft routes as awaiting_site_review when any route is draft only', () => {
    const plan = makePlan([NEXT_SIGNED_TARGET, LEGAL_TARGETS.nuxtGit])
    const draft = receiptFor(plan, 0)
    const delivered = makeReceipt(plan, plan.routes[1]!, { executorRunId: opaque('ref-delivered-second'), status: 'delivered' })
    const events = [
      makeEvent(plan, plan.routes[0]!),
      makeEvent(plan, plan.routes[1]!),
      makeResultEvent(plan, draft, 2),
      makeResultEvent(plan, delivered, 2),
    ]

    expect(aggregateEvents(plan, events, [draft, delivered])).toMatchObject({
      overall: 'awaiting_site_review',
      routes: expect.arrayContaining([
        expect.objectContaining({ routeId: draft.routeId, status: 'draft_received' }),
        expect.objectContaining({ routeId: delivered.routeId, status: 'delivered' }),
      ]),
    })
  })

  it('does not aggregate mixed draft and failed routes as delivered or awaiting review', () => {
    const plan = makePlan([NEXT_SIGNED_TARGET, LEGAL_TARGETS.wordpress])
    const draft = receiptFor(plan, 0)
    const failed = makeReceipt(plan, plan.routes[1]!, { executorRunId: opaque('ref-failed-second'), status: 'failed' })
    const events = [
      makeEvent(plan, plan.routes[0]!),
      makeEvent(plan, plan.routes[1]!),
      makeResultEvent(plan, draft, 2),
      makeResultEvent(plan, failed, 2),
    ]

    expect(aggregateEvents(plan, events, [draft, failed]).overall).toBe('partial')
  })

  it('stores a validated adapter draft receipt, binds it to the route, and replays exact history without calling the adapter again', async () => {
    const plan = nextPlan()
    const route = plan.routes[0]!
    const adapter = adapterFor(receiptFor(plan).draftReceipt)
    const input = executeInput(plan)
    const first = await executeMultiChannelPublication({
      ...input,
      registry: { first_party_signed_api: adapter },
    })
    expect(first.status).toBe('draft_received')
    expect(first.receipt).toMatchObject({ status: 'draft_received', draftReceipt: receiptFor(plan).draftReceipt })
    expect(JSON.stringify(first.receipt)).not.toMatch(/publicUrl|remoteRevision|revision/iu)
    expect(adapter).toHaveBeenCalledTimes(1)

    const second = await executeMultiChannelPublication({
      ...input,
      now: input.now + 5_000,
      knownReceipts: [first.receipt],
      registry: { first_party_signed_api: adapter },
    })
    expect(second).toMatchObject({ status: 'draft_received', replay: true, receipt: first.receipt })
    expect(second.receiptFingerprint).toBe(fingerprint(first.receipt!))
    expect(adapter).toHaveBeenCalledTimes(1)

    const mismatch = adapterFor({ ...receiptFor(plan).draftReceipt!, publicationId: `${route.destinationPublicationIdentity}-other` })
    const rejected = await executeMultiChannelPublication({ ...input, registry: { first_party_signed_api: mismatch } })
    expect(rejected.status).toBe('blocked')
    expect(rejected.receipt?.status).toBe('blocked')
    expect(rejected.receipt).not.toHaveProperty('draftReceipt')
  })

  it('surfaces the review state in fanout but preserves failure and retry status for mixed routes', async () => {
    const reviewPlan = makePlan([NEXT_SIGNED_TARGET, { ...NEXT_SIGNED_TARGET, targetId: 'target-nextjs-signed-002', siteIdentity: 'site-nextjs-signed-002', destinationPublicationIdentity: 'destination-nextjs-002', targetUrl: 'https://nextjs-api-2.routing.discoverystack.dev', credentialReference: opaque('ref-hmac-nextjs-002') }])
    const adapter: MultiChannelAdapter = async input => input.route.targetId === NEXT_SIGNED_TARGET.targetId
      ? { status: 'draft_received', receipt: receiptFor(reviewPlan, 0).draftReceipt! }
      : { status: 'delivered', remote: { publicationId: input.route.destinationPublicationIdentity, contentHash: input.route.contentHash, remoteRevision: 'synthetic-revision' } }
    const allReviewable = await executeMultiChannelFanout({
      plan: reviewPlan,
      routeIds: reviewPlan.routes.map(route => route.routeId),
      content: FIXTURE_CONTENT,
      idempotencyKey: 'fanout-review',
      executorRunIdPrefix: 'fanout-review-run',
      attempt: 1,
      now: FIXTURE_NOW + 100,
      mode: 'execute',
      registry: { first_party_signed_api: adapter },
      resolveCredential: async () => 'synthetic-test-credential',
    })
    expect(allReviewable.status).toBe('awaiting_site_review')
    expect(allReviewable.results.map(result => result.status)).toEqual(['draft_received', 'delivered'])
    expect(allReviewable.receipts).toHaveLength(2)

    const mixedPlan = makePlan([NEXT_SIGNED_TARGET, LEGAL_TARGETS.wordpress])
    const draftAdapter: MultiChannelAdapter = async () => ({ status: 'draft_received', receipt: receiptFor(mixedPlan, 0).draftReceipt! })
    const blockedAdapter: MultiChannelAdapter = async () => ({ status: 'blocked', reason: 'synthetic target policy rejection' })
    const mixed = await executeMultiChannelFanout({
      plan: mixedPlan,
      routeIds: mixedPlan.routes.map(route => route.routeId),
      content: FIXTURE_CONTENT,
      idempotencyKey: 'fanout-mixed',
      executorRunIdPrefix: 'fanout-mixed-run',
      attempt: 1,
      now: FIXTURE_NOW + 100,
      mode: 'execute',
      registry: { first_party_signed_api: draftAdapter, wordpress_rest: blockedAdapter },
      resolveCredential: async () => 'synthetic-test-credential',
    })
    expect(mixed.status).toBe('blocked')
    expect(mixed.status).not.toBe('delivered')

    const retryAdapter: MultiChannelAdapter = async () => ({ status: 'retry_wait', reason: 'synthetic transient target failure' })
    const mixedRetry = await executeMultiChannelFanout({
      plan: mixedPlan,
      routeIds: mixedPlan.routes.map(route => route.routeId),
      content: FIXTURE_CONTENT,
      idempotencyKey: 'fanout-mixed-retry',
      executorRunIdPrefix: 'fanout-mixed-retry-run',
      attempt: 1,
      now: FIXTURE_NOW + 100,
      mode: 'execute',
      registry: { first_party_signed_api: draftAdapter, wordpress_rest: retryAdapter },
      resolveCredential: async () => 'synthetic-test-credential',
    })
    expect(mixedRetry.status).toBe('retry_wait')
    expect(mixedRetry.results.map(result => result.status)).toEqual(['draft_received', 'retry_wait'])
  })
})
