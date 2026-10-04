import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { activateWeeklyReviewConfig, claimLineBindingInvite, createReviewRequest, deriveReviewTokens, issueLineBindingInvite, reviewFromVerifiedLine } from '../server/weekly-content/service'
import { confirmWeeklyLiffConnection, getWeeklyLiffConnectContext, weeklyLiffConfiguration, type WeeklyLiffDependencies } from '../server/weekly-content/liff-service'
import { WeeklyFixture, WEEKLY_HASH, WEEKLY_KEY, WEEKLY_NOW, sha } from './fixtures/weekly-content/repository'

const USER = `U${'1'.repeat(32)}`
const OTHER = `U${'2'.repeat(32)}`
const ID_TOKEN = 'synthetic.header.signature'
const CHANNEL = '2001234567'
const ENV = { NUXT_WEEKLY_CONTENT_APPROVAL_ENABLED: 'true', NUXT_WEEKLY_CONTENT_LIFF_ENABLED: 'true', NUXT_WEEKLY_CONTENT_LIFF_ID: `${CHANNEL}-Abcd1234`, NUXT_WEEKLY_CONTENT_LINE_LOGIN_CHANNEL_ID: CHANNEL, NUXT_WEEKLY_CONTENT_TOKEN_KEY: WEEKLY_KEY, NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN: 'https://synthetic-weekly.taipei' }

function fixture() {
  const f = new WeeklyFixture()
  f.state.client.requireCustomerApproval = false
  f.state.target.executionEnabled = false
  f.state.policy.status = 'paused'
  f.state.policy.generationBudget = 0
  f.state.policy.publicationBudget = 0
  vi.mocked(f.repository.getTargetPolicy).mockResolvedValue(null)
  const deps: WeeklyLiffDependencies = {
    configuration: weeklyLiffConfiguration(ENV), repository: vi.fn(() => f.repository), now: WEEKLY_NOW,
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ iss: 'https://access.line.me', aud: CHANNEL, sub: USER, iat: Math.floor(WEEKLY_NOW.getTime() / 1000) - 100, exp: Math.floor(WEEKLY_NOW.getTime() / 1000) + 3500 }), { headers: { 'content-type': 'application/json' } })),
  }
  return { f, deps }
}

async function confirmation(f: WeeklyFixture, deps: WeeklyLiffDependencies) {
  const invite = await issueLineBindingInvite({ ownerUserId: 1, clientId: 1 }, f.deps())
  const context = await getWeeklyLiffConnectContext({ idToken: ID_TOKEN, invitationToken: invite.invitationToken }, deps)
  if (context.mode !== 'invitation') throw new Error('Expected synthetic invitation context.')
  return { invite, context, input: { idToken: ID_TOKEN, invitationToken: invite.invitationToken, confirmationToken: context.confirmationToken, consent: true } }
}

describe('company/LINE identity binding is independent of article authority', () => {
  it('binds an active client without config, target/policy or approval opt-in and writes no article authority', async () => {
    const { f, deps } = fixture(), before = structuredClone({ client: f.state.client, target: f.state.target, policy: f.state.policy })
    const { invite, context, input } = await confirmation(f, deps)
    expect(invite.purpose).toBe('identity_binding')
    expect(context.purpose).toBe('identity_binding')
    expect(f.state.invites[0]?.consumedAt).toBeNull()
    const result = await confirmWeeklyLiffConnection(input, deps)
    expect(result).toEqual({ status: 'bound', purpose: 'identity_binding', company: context.company })
    expect({ client: f.state.client, target: f.state.target, policy: f.state.policy }).toEqual(before)
    expect(f.state.config).toBeNull()
    expect(f.repository.getConfig).not.toHaveBeenCalled()
    expect(f.repository.getTargetPolicy).not.toHaveBeenCalled()
    expect(f.repository.requireClientApproval).not.toHaveBeenCalled()
    expect(f.repository.saveConfig).not.toHaveBeenCalled()
    expect(f.state.requests).toHaveLength(0)
    expect(f.state.consents).toHaveLength(0)
    expect(f.state.outbox).toHaveLength(0)
    expect(f.state.queued).toBe(0)
    expect(f.state.inbox).toHaveLength(1)
    expect(f.state.binding?.lineUserId).toBe(USER)
    for (const value of [USER, ID_TOKEN, WEEKLY_KEY, invite.invitationToken]) expect(JSON.stringify(result)).not.toContain(value)
    expect(await getWeeklyLiffConnectContext({ idToken: ID_TOKEN }, deps)).toEqual({ mode: 'bindings', companies: [context.company] })
  })

  it.each(['owner', 'client', 'paused', 'archived'] as const)('rejects a %s company before issuing an invite', async kind => {
    const { f } = fixture()
    if (kind === 'paused' || kind === 'archived') f.state.client.status = kind
    await expect(issueLineBindingInvite({ ownerUserId: kind === 'owner' ? 2 : 1, clientId: kind === 'client' ? 2 : 1 }, f.deps())).rejects.toThrow('WEEKLY_CLIENT_NOT_AVAILABLE')
    expect(f.state.invites).toHaveLength(0)
    expect(f.state.binding).toBeNull()
  })

  it.each(['owner', 'client', 'paused'] as const)('rechecks company %s inside confirmation before any binding write', async kind => {
    const { f, deps } = fixture(), { input } = await confirmation(f, deps)
    if (kind === 'owner') f.state.client.ownerUserId = 2
    if (kind === 'client') f.state.client.id = 2
    if (kind === 'paused') f.state.client.status = 'paused'
    await expect(confirmWeeklyLiffConnection(input, deps)).rejects.toMatchObject({ statusCode: 409 })
    expect(f.state.binding).toBeNull()
    expect(f.state.inbox).toHaveLength(0)
    expect(f.state.invites[0]?.consumedAt).toBeNull()
  })

  it('same-user concurrent confirmation writes one binding/inbox and another user cannot reuse the invite', async () => {
    const { f, deps } = fixture(), { input, invite } = await confirmation(f, deps)
    expect((await Promise.all([confirmWeeklyLiffConnection(input, deps), confirmWeeklyLiffConnection(input, deps)])).map(row => row.status).sort()).toEqual(['bound', 'replayed'])
    expect(f.repository.saveBinding).toHaveBeenCalledTimes(1)
    expect(f.state.inbox).toHaveLength(1)
    await expect(claimLineBindingInvite({ invitationToken: invite.invitationToken, lineUserId: OTHER, webhookEventId: 'synthetic-other-claim', semanticFingerprint: sha('other') }, f.deps())).rejects.toThrow('WEEKLY_INVITATION_ALREADY_USED')
    expect(f.state.binding?.lineUserId).toBe(USER)
    expect(f.state.consents).toHaveLength(0)
    expect(f.state.queued).toBe(0)
  })

  it('the signed core claim also rejects a client paused after invitation issuance', async () => {
    const { f, deps } = fixture(), { invite } = await confirmation(f, deps)
    f.state.client.status = 'paused'
    await expect(claimLineBindingInvite({ invitationToken: invite.invitationToken, lineUserId: USER, webhookEventId: 'synthetic-paused-core-claim', semanticFingerprint: sha('paused') }, f.deps())).rejects.toThrow('WEEKLY_CLIENT_NOT_AVAILABLE')
    expect(f.state.binding).toBeNull()
    expect(f.state.inbox).toHaveLength(0)
    expect(f.state.invites[0]?.consumedAt).toBeNull()
  })

  it('an unconfigured client still has a strict ten-minute TTL and reissuing invalidates its previous invite', async () => {
    const { f, deps } = fixture(), first = await confirmation(f, deps)
    expect(Date.parse(first.invite.expiresAt) - WEEKLY_NOW.getTime()).toBe(600000)
    await issueLineBindingInvite({ ownerUserId: 1, clientId: 1 }, f.deps())
    await expect(confirmWeeklyLiffConnection(first.input, deps)).rejects.toMatchObject({ statusCode: 409 })
    const current = await confirmation(f, deps)
    await expect(confirmWeeklyLiffConnection(current.input, { ...deps, now: new Date(current.invite.expiresAt) })).rejects.toMatchObject({ statusCode: 409 })
    expect(f.state.binding).toBeNull()
    expect(f.state.inbox).toHaveLength(0)
    expect(f.state.config).toBeNull()
  })

  it('rejects the legacy configuration-bound confirmation purpose instead of reinterpreting its consent', async () => {
    const { f, deps } = fixture(), { input, context } = await confirmation(f, deps), row = f.state.invites[0]
    if (!row) throw new Error('Expected synthetic invitation row.')
    const legacy = createHmac('sha256', WEEKLY_KEY).update(JSON.stringify({ purpose: 'weekly-liff-confirm-v1', invitationHash: row.tokenHash, invitationExpiresAt: row.expiresAt.toISOString(), owner: 1, client: 1, company: context.company, configurationFingerprint: WEEKLY_HASH, channel: CHANNEL, recipient: USER })).digest('base64url')
    await expect(confirmWeeklyLiffConnection({ ...input, confirmationToken: legacy }, deps)).rejects.toThrow('LIFF_COMPANY_CONFIRMATION_CHANGED')
    expect(f.state.binding).toBeNull()
    expect(f.state.inbox).toHaveLength(0)
    expect(f.state.invites[0]?.consumedAt).toBeNull()
  })

  it('identity binding alone cannot create a review request or queue a publication', async () => {
    const { f, deps } = fixture(), { input } = await confirmation(f, deps)
    await confirmWeeklyLiffConnection(input, deps)
    await expect(createReviewRequest({ ownerUserId: 1, clientId: 1, entryId: 8 }, f.deps())).rejects.toThrow('WEEKLY_MACHINE_REVIEW_NOT_READY')
    expect(f.state.config).toBeNull()
    expect(f.state.client.requireCustomerApproval).toBe(false)
    expect(f.state.requests).toHaveLength(0)
    expect(f.state.outbox).toHaveLength(0)
    expect(f.state.consents).toHaveLength(0)
    expect(f.state.queued).toBe(0)
  })

  it('later explicit owner activation may use the verified identity, but the invite never substitutes for article consent', async () => {
    const { f, deps } = fixture(), { input, invite } = await confirmation(f, deps)
    await confirmWeeklyLiffConnection(input, deps)
    f.state.target.executionEnabled = true
    f.state.policy.status = 'enabled'
    f.state.policy.generationBudget = 10
    f.state.policy.publicationBudget = 10
    vi.mocked(f.repository.getTargetPolicy).mockResolvedValue({ target: f.state.target, policy: f.state.policy })
    await activateWeeklyReviewConfig({ ownerUserId: 1, clientId: 1, publicationTargetId: 3, policyId: f.state.policy.policyId, idempotencyKey: 'synthetic-later-owner-activation' }, f.deps())
    await createReviewRequest({ ownerUserId: 1, clientId: 1, entryId: 8 }, f.deps())
    const request = f.state.requests[0]
    if (!request) throw new Error('Expected synthetic review request.')
    const decision = { lineUserId: USER, webhookEventId: 'synthetic-article-decision', semanticFingerprint: sha('article-decision'), requestId: request.requestId, decision: 'approved' as const }
    await expect(reviewFromVerifiedLine({ ...decision, actionToken: invite.invitationToken }, f.deps())).rejects.toThrow('WEEKLY_ACTION_TOKEN_INVALID')
    expect(f.state.consents).toHaveLength(0)
    expect(f.state.queued).toBe(0)
    await reviewFromVerifiedLine({ ...decision, actionToken: deriveReviewTokens(request, WEEKLY_KEY).actionToken }, f.deps())
    expect(f.state.consents).toHaveLength(1)
    expect(f.state.queued).toBe(1)
  })
})
