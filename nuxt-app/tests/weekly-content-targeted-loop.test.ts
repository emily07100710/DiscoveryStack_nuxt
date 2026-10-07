import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { enableOwnerAutopilotPolicy } from '../server/content-operations/autopilot-policy'
import { runWeeklyContentTick, type WeeklyRuntimeDependencies } from '../server/weekly-content/runtime'
import { runWeeklyLineOutbox, type WeeklyLineOutboxDependencies } from '../server/weekly-content/line-outbox'
import { createWeeklyContentRepositoryFromDatabase, type WeeklyContentRepository } from '../server/weekly-content/repository'
import { processWeeklyLineWebhook } from '../server/weekly-content/line-webhook'
import { activateWeeklyReviewConfig, createReviewRequest, deriveReviewTokens, issueLineBindingInvite } from '../server/weekly-content/service'
import { encodeWeeklyLinePostback } from '../server/weekly-content/line-transport'
import { WeeklyFixture, WEEKLY_NOW, WEEKLY_KEY } from './fixtures/weekly-content/repository'
import type { WeeklyConfig, WeeklyOutbox } from '../server/weekly-content/types'
import type { ContentOperationAutopilotPolicyRow } from '../server/content-operations/types'

const OWNER = 1
const TARGET_CLIENT = 51
const USER = `U${'1'.repeat(32)}`
const OTHER_USER = `U${'3'.repeat(32)}`
const BOT = `U${'2'.repeat(32)}`
const SECRET = '0'.repeat(32)
const ACCESS = 'synthetic-line-access-token-only'
const ORIGIN = 'https://preview.example.com'
const HASH = 'a'.repeat(64)
const sha = (value: string) => createHmac('sha256', 'synthetic-test-hash').update(value).digest('hex')

function signed(events: unknown[], destination = BOT) {
  const rawBody = Buffer.from(JSON.stringify({ destination, events }))
  return { rawBody, signature: createHmac('sha256', SECRET).update(rawBody).digest('base64') }
}

function postback(patch: Record<string, unknown> = {}) {
  return {
    type: 'postback', mode: 'active', timestamp: WEEKLY_NOW.getTime(),
    source: { type: 'user', userId: USER }, webhookEventId: '01FZ74A0TDDPYRVKNK77XKC3ZS',
    postback: { data: '' }, ...patch,
  }
}

function runtimeDeps(weekly: WeeklyFixture, values: { owner?: number; client?: number; includeEntry?: boolean } = {}) {
  const owner = values.owner ?? OWNER, client = values.client ?? 1
  const policy = canonicalPolicy(weekly, owner, client)
  const config = { ...weekly.state.config!, ownerUserId: owner, clientId: client, policyId: policy.policyId, policyConfigurationFingerprint: policy.configurationFingerprint } as WeeklyConfig
  const binding = weekly.state.binding
    ? { ...weekly.state.binding, ownerUserId: owner, clientId: client }
    : { id: 91, ownerUserId: owner, clientId: client, status: 'active', bindingFingerprint: HASH, lineUserId: USER, identityBoundAt: WEEKLY_NOW } as never
  const target = { ...weekly.state.target, ownerUserId: owner, clientId: client }
  const repository = weekly.repository
  vi.mocked(repository.getConfig).mockImplementation(async (requestedOwner, requestedClient) => requestedOwner === owner && requestedClient === client ? config : null)
  vi.mocked(repository.listConfigs).mockResolvedValue(Array.from({ length: 50 }, (_, index) => ({ ...config, id: index + 1, clientId: index + 1 })))
  vi.mocked(repository.claimSchedulerConfigs).mockResolvedValue([config])
  vi.mocked(repository.getTargetPolicy).mockImplementation(async (requestedOwner, requestedClient, targetId, policyId) => requestedOwner === owner && requestedClient === client && targetId === target.id && policyId === policy.policyId ? { target, policy } : null)
  vi.mocked(repository.getBinding).mockImplementation(async (requestedOwner, requestedClient) => requestedOwner === owner && requestedClient === client ? binding as never : null)

  const calendar = { id: 71, ownerUserId: owner, clientId: client, timeZone: 'Asia/Taipei', status: 'active', planFingerprint: HASH }
  const entry = { id: 8, ownerUserId: owner, clientId: client, calendarId: calendar.id, plannedLocalDate: '2026-10-01', status: 'ready_to_publish', contentType: 'article', language: 'zh-hant', evidenceSnapshotHash: HASH }
  const operations = {
    listCalendars: vi.fn(async () => values.includeEntry ? [calendar] : []),
    listEntries: vi.fn(async () => values.includeEntry ? [entry] : []),
    findEntry: vi.fn(async () => values.includeEntry ? entry : null),
  }
  const roll = vi.fn(async () => ({ status: 'completed' }))
  const workflow = vi.fn(async (input: { exactDraftOnly?: boolean }) => ({ outcome: input.exactDraftOnly ? 'ready_to_publish' : 'ready_to_publish' }))
  const publish = vi.fn(async () => ({ outcome: 'published' }))
  const send = vi.fn(async () => ({ status: 'completed', claimed: 0, sent: 0, deduplicated: 0, retryWaiting: 0, failed: 0, cancelled: 0, leaseLost: 0 }))
  const deps = {
    weekly: weekly.deps(), operations: operations as never, roll, workflow, publish, send, runtime: {} as never,
  } as unknown as WeeklyRuntimeDependencies
  return { deps, config, target, policy, binding, operations, roll, workflow, publish, send }
}

function canonicalPolicy(weekly: WeeklyFixture, owner: number, client: number): ContentOperationAutopilotPolicyRow {
  const policy = enableOwnerAutopilotPolicy({
    policyVersion: 'governed-autopilot-policy-v4', ownerUserId: owner, clientId: client, targetRowId: 3, targetId: 'primary',
    authorizedByOwnerUserId: owner, authorizedAt: WEEKLY_NOW.toISOString(), expiresAt: '2027-01-01T00:00:00.000Z',
    allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'], cadenceDays: 7, allowedTargetIds: ['primary'],
    allowedDestinations: ['primary'], allowedCadences: [7], maximumRiskSeverity: 'moderate', allowedBusinessRiskClasses: ['general'],
    evidenceFreshnessHours: 720, maximumRiskLevel: 'general', requiredQualityGateVersion: 'content-risk-gate-v1',
    allowedProviderModels: ['qwen-plus'], generationBudget: 10, publicationBudget: 10,
  })
  return {
    ...weekly.state.policy, ownerUserId: owner, clientId: client, publicationTargetId: 3, policyId: policy.policyId,
    policyVersion: policy.policyVersion, mode: policy.mode, websiteId: policy.websiteId, authorizedByOwnerUserId: owner,
    authorizedAt: new Date(policy.authorizedAt), expiresAt: new Date(policy.expiresAt), revokedAt: null, status: 'enabled',
    allowedContentTypes: [...policy.allowedContentTypes], allowedLanguages: [...policy.allowedLanguages], cadenceDays: 7,
    evidenceFreshnessHours: policy.evidenceFreshnessHours, maximumRiskLevel: policy.maximumRiskLevel,
    requiredQualityGateVersion: policy.requiredQualityGateVersion, allowedTargetIds: [...policy.allowedTargetIds],
    allowedProviderModels: [...policy.allowedProviderModels], allowedDestinations: [...policy.allowedDestinations],
    allowedCadences: [...policy.allowedCadences], allowedRiskClasses: [...policy.allowedRiskClasses],
    riskSemanticsVersion: policy.riskSemanticsVersion, maximumRiskSeverity: policy.maximumRiskSeverity,
    allowedBusinessRiskClasses: [...policy.allowedBusinessRiskClasses], entityStrategyProfileId: policy.entityStrategyProfileId,
    maximumRepairAttempts: policy.maximumRepairAttempts, maximumTopicSubstitutions: policy.maximumTopicSubstitutions,
    generationBudget: policy.generationBudget, publicationBudget: policy.publicationBudget, generationBudgetUsed: 0,
    publicationBudgetUsed: 0, activatedAt: new Date(policy.activatedAt), requireApprovedForDelivery: false,
    requirePassedRiskGate: true, configurationFingerprint: policy.configurationFingerprint,
  }
}

async function approvedWebhookFixture() {
  const fixture = new WeeklyFixture()
  fixture.state.policy = canonicalPolicy(fixture, OWNER, 1)
  const deps = fixture.deps()
  await activateWeeklyReviewConfig({ ownerUserId: OWNER, clientId: 1, publicationTargetId: 3, policyId: fixture.state.policy.policyId, idempotencyKey: 'targeted-worker-integration' }, deps)
  const invite = await issueLineBindingInvite({ ownerUserId: OWNER, clientId: 1 }, deps)
  const options = { featureEnabled: true, channelSecret: SECRET, botUserId: BOT, getDependencies: vi.fn(async () => deps) }
  const bindEvent = { type: 'message', mode: 'active', timestamp: WEEKLY_NOW.getTime(), source: { type: 'user', userId: USER }, webhookEventId: '01FZ74A0TDDPYRVKNK77XKC3ZR', message: { type: 'text', text: invite.invitationToken } }
  await processWeeklyLineWebhook({ ...options, ...signed([bindEvent]) })
  const created = await createReviewRequest({ ownerUserId: OWNER, clientId: 1, entryId: fixture.state.draft.entryId }, deps)
  const request = fixture.state.requests[0]!
  const actionToken = deriveReviewTokens(request, deps.tokenKey).actionToken
  const approval = postback({ postback: { data: encodeWeeklyLinePostback(created.request.requestId, actionToken, 'approved') } })
  return { fixture, deps, options, request, approval }
}

describe('client targeted weekly worker', () => {
  it('loads an exact active client beyond the first 50 and never uses batch lookup', async () => {
    const weekly = new WeeklyFixture()
    await activateWeeklyReviewConfig({ ownerUserId: OWNER, clientId: 1, publicationTargetId: 3, policyId: 'policy-1', idempotencyKey: 'targeted-batch' }, weekly.deps())
    const f = runtimeDeps(weekly, { client: TARGET_CLIENT })
    const result = await runWeeklyContentTick({ ownerUserId: OWNER, clientId: TARGET_CLIENT, maxClients: 1, now: WEEKLY_NOW }, {
      featureEnabled: true, schedulerEnabled: true, configurationReady: true, getDependencies: () => f.deps,
    })
    expect(result.clients).toEqual([{ clientId: TARGET_CLIENT, status: 'completed' }])
    expect(weekly.repository.getConfig).toHaveBeenCalledWith(OWNER, TARGET_CLIENT)
    expect(weekly.repository.listConfigs).not.toHaveBeenCalled()
    expect(f.roll).toHaveBeenCalledWith(OWNER, TARGET_CLIENT, WEEKLY_NOW)
    expect(f.send).toHaveBeenCalledWith({ ownerUserId: OWNER, clientId: TARGET_CLIENT, maxMessages: 1 }, expect.any(Object))
  })

  it.each([
    ['missing', null],
    ['foreign owner', { ownerUserId: 999, clientId: TARGET_CLIENT, status: 'active' }],
    ['foreign client', { ownerUserId: OWNER, clientId: TARGET_CLIENT - 1, status: 'active' }],
    ['paused', { ownerUserId: OWNER, clientId: TARGET_CLIENT, status: 'paused' }],
  ] as const)('does not process or notify a %s target', async (_kind, returned) => {
    const weekly = new WeeklyFixture()
    const f = runtimeDeps(weekly, { client: TARGET_CLIENT })
    vi.mocked(weekly.repository.getConfig).mockResolvedValue(returned as never)
    const result = await runWeeklyContentTick({ ownerUserId: OWNER, clientId: TARGET_CLIENT }, {
      featureEnabled: true, schedulerEnabled: true, configurationReady: true, getDependencies: () => f.deps,
    })
    expect(result.processed).toBe(0)
    expect(f.roll).not.toHaveBeenCalled(); expect(f.workflow).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
    expect(weekly.repository.listConfigs).not.toHaveBeenCalled()
  })

  it('rejects a malformed target before constructing dependencies, after static gates', async () => {
    const getDependencies = vi.fn()
    await expect(runWeeklyContentTick({ ownerUserId: OWNER, clientId: 0 }, { featureEnabled: true, schedulerEnabled: true, configurationReady: true, getDependencies: getDependencies as never })).rejects.toMatchObject({ statusCode: 422 })
    expect(getDependencies).not.toHaveBeenCalled()
  })

  it('uses the persistent fair scheduler claim for untargeted ticks', async () => {
    const weekly = new WeeklyFixture()
    await activateWeeklyReviewConfig({ ownerUserId: OWNER, clientId: 1, publicationTargetId: 3, policyId: 'policy-1', idempotencyKey: 'legacy-tick' }, weekly.deps())
    const f = runtimeDeps(weekly, { client: 1 })
    await runWeeklyContentTick({ ownerUserId: OWNER, maxClients: 1, now: WEEKLY_NOW }, { featureEnabled: true, schedulerEnabled: true, configurationReady: true, getDependencies: () => f.deps })
    expect(weekly.repository.claimSchedulerConfigs).toHaveBeenCalledWith(OWNER, 1)
    expect(weekly.repository.listConfigs).not.toHaveBeenCalled()
    expect(f.send).toHaveBeenCalledWith({ ownerUserId: OWNER, maxMessages: 1 }, expect.any(Object))
  })
})

describe('targeted outbox claim scope', () => {
  it('passes the exact client to the repository and ignores any foreign row before request/provider reads', async () => {
    const row = { id: 9, ownerUserId: OWNER, clientId: TARGET_CLIENT + 1, requestRowId: 7, status: 'processing', leaseToken: null, leaseExpiresAt: null } as WeeklyOutbox
    const repository = {
      claimOutbox: vi.fn(async (_owner: number, _max: number, leaseToken: string) => [{ ...row, status: 'processing' as const, leaseToken, leaseExpiresAt: new Date(WEEKLY_NOW.getTime() + 120000) }]),
      getRequestByRowId: vi.fn(), getConfig: vi.fn(), getBinding: vi.fn(), getDraft: vi.fn(), reserveOutboxPayload: vi.fn(), finishOutbox: vi.fn(),
    }
    const fetchImpl = vi.fn<typeof fetch>()
    const deps = { repository: repository as unknown as WeeklyContentRepository, featureEnabled: true, tokenKey: WEEKLY_KEY, botUserId: BOT, publicOrigin: ORIGIN, channelAccessToken: ACCESS, fetchImpl, now: WEEKLY_NOW } as WeeklyLineOutboxDependencies
    expect(await runWeeklyLineOutbox({ ownerUserId: OWNER, clientId: TARGET_CLIENT }, deps)).toMatchObject({ claimed: 1, leaseLost: 1, sent: 0 })
    expect(repository.claimOutbox).toHaveBeenCalledWith(OWNER, 10, expect.any(String), WEEKLY_NOW, TARGET_CLIENT)
    expect(repository.getRequestByRowId).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps the client predicate in both the candidate select and lease compare-and-set', async () => {
    const clauses: unknown[] = []
    let selectCount = 0
    const candidate = { id: 99, ownerUserId: OWNER, clientId: TARGET_CLIENT, requestRowId: 77, bindingId: 78, status: 'queued', attemptNumber: 0, createdAt: WEEKLY_NOW, updatedAt: WEEKLY_NOW } as WeeklyOutbox
    const empty = () => ({ where(value: unknown) { clauses.push(value); return this }, orderBy() { return this }, limit: async () => (++selectCount === 1 ? [candidate] : []) })
    const database = {
      select: () => ({ from: () => empty() }),
      update: () => ({ set: () => ({ where: async (value: unknown) => { clauses.push(value); return [{ affectedRows: 1 }] } }) }),
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(database),
    }
    await createWeeklyContentRepositoryFromDatabase(database).claimOutbox(OWNER, 10, 'lease-token', WEEKLY_NOW, TARGET_CLIENT)
    expect(clauses).toHaveLength(3)
    const dialect = new MySqlDialect()
    for (const clause of clauses.slice(0, 2)) {
      const query = dialect.sqlToQuery(clause as never)
      expect(query.sql).toContain('clientId')
      expect(query.params).toContain(TARGET_CLIENT)
      expect(query.params).toContain(OWNER)
    }
  })

  it('preserves four-argument repository claim calls for untargeted outbox processing', async () => {
    const repository = { claimOutbox: vi.fn(async () => []), getRequestByRowId: vi.fn(), getConfig: vi.fn(), getBinding: vi.fn(), getDraft: vi.fn(), reserveOutboxPayload: vi.fn(), finishOutbox: vi.fn() }
    const deps = { repository: repository as unknown as WeeklyContentRepository, featureEnabled: true, tokenKey: WEEKLY_KEY, botUserId: BOT, publicOrigin: ORIGIN, channelAccessToken: ACCESS, fetchImpl: vi.fn(), now: WEEKLY_NOW } as WeeklyLineOutboxDependencies
    await runWeeklyLineOutbox({ ownerUserId: OWNER }, deps)
    expect(repository.claimOutbox).toHaveBeenCalledWith(OWNER, 10, expect.any(String), WEEKLY_NOW)
  })
})

describe('signed LINE consent to next targeted worker publication', () => {
  it('commits actual signed consent without publishing in the webhook, then publishes the exact draft on the next worker tick', async () => {
    const f = await approvedWebhookFixture()
    expect(f.fixture.state.requests[0]?.status).toBe('pending')
    expect(f.fixture.state.consents).toHaveLength(0)
    const action = signed([f.approval])
    expect(await processWeeklyLineWebhook({ ...f.options, ...action })).toMatchObject({ status: 'accepted', processed: 1 })
    expect(await processWeeklyLineWebhook({ ...f.options, ...action })).toMatchObject({ status: 'accepted', processed: 1 })
    expect(f.fixture.state.requests[0]?.status).toBe('approved')
    expect(f.fixture.state.consents).toHaveLength(1)
    expect(f.fixture.state.queued).toBe(1)
    // The webhook has no provider transport configured and never invokes publication.
    expect(f.fixture.state.outbox[0]?.status).toBe('queued')

    const runtime = runtimeDeps(f.fixture, { client: 1, includeEntry: true })
    const originalDraft = { ...f.fixture.state.draft }
    runtime.workflow.mockImplementation(async input => {
      expect(input.exactDraftOnly).toBe(true)
      expect(f.fixture.state.draft).toMatchObject({ draftId: originalDraft.draftId, draftVersion: originalDraft.draftVersion, contentHash: originalDraft.contentHash })
      return { outcome: 'ready_to_publish' } as never
    })
    const result = await runWeeklyContentTick({ ownerUserId: OWNER, clientId: 1, now: WEEKLY_NOW }, { featureEnabled: true, schedulerEnabled: true, configurationReady: true, getDependencies: () => runtime.deps })
    expect(runtime.workflow).toHaveBeenCalledWith(expect.objectContaining({ entryId: f.fixture.state.draft.entryId, queueOnly: true, exactDraftOnly: true, dependencies: expect.any(Object) }))
    expect(runtime.publish).toHaveBeenCalledTimes(1)
    expect(result.publicationAttempted).toBe(1)
    expect(result.clients).toContainEqual({ clientId: 1, status: 'published' })
  })

  it('rejects redelivery collisions, out-of-order edits, wrong sender, expiry and changed draft before publication', async () => {
    const wrong = await approvedWebhookFixture()
    const wrongSender = { ...wrong.approval, source: { type: 'user', userId: OTHER_USER } }
    expect(await processWeeklyLineWebhook({ ...wrong.options, ...signed([wrongSender]) })).toMatchObject({ processed: 0, ignored: 1 })
    expect(wrong.fixture.state.consents).toHaveLength(0)

    const collided = await approvedWebhookFixture()
    await processWeeklyLineWebhook({ ...collided.options, ...signed([collided.approval]) })
    const token = deriveReviewTokens(collided.request, collided.deps.tokenKey).actionToken
    await processWeeklyLineWebhook({ ...collided.options, ...signed([{ ...collided.approval, postback: { data: encodeWeeklyLinePostback(collided.request.requestId, token, 'changes_requested') } }]) })
    expect(collided.fixture.state.consents).toHaveLength(1)
    expect(collided.fixture.state.requests[0]?.status).toBe('approved')

    for (const mutation of ['expired', 'edited'] as const) {
      const f = await approvedWebhookFixture()
      await processWeeklyLineWebhook({ ...f.options, ...signed([f.approval]) })
      if (mutation === 'edited') { f.fixture.state.draft.draftVersion += 1; f.fixture.state.draft.contentHash = 'f'.repeat(64) }
      const runtime = runtimeDeps(f.fixture, { client: 1, includeEntry: true })
      const now = mutation === 'expired' ? f.fixture.state.requests[0]!.expiresAt : WEEKLY_NOW
      const result = await runWeeklyContentTick({ ownerUserId: OWNER, clientId: 1, now }, { featureEnabled: true, schedulerEnabled: true, configurationReady: true, getDependencies: () => runtime.deps })
      expect(runtime.publish).not.toHaveBeenCalled()
      expect(result.publicationAttempted).toBe(0)
    }
  })
})
