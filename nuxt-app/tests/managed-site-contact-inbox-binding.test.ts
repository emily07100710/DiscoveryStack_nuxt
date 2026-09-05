import { randomBytes } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import type { ManagedSiteFunnelSession } from '../server/database/schema'
import { confirmManagedSiteContactInboxBinding, managedSiteContactInboxProjection, setManagedSiteContactInboxBindingDependenciesForTests, startManagedSiteContactInboxBinding, type ManagedSiteContactInboxBindingDependencies } from '../server/managed-sites/contact-inbox/binding-service'
import { createRecordingManagedSiteEmailTransport } from '../server/managed-sites/contact-inbox/email-transport'
import { createPaidManagedSiteModuleFulfilments } from '../server/managed-sites/funnel/module-fulfilment'
import { setManagedSiteFunnelRepositoryForTests } from '../server/managed-sites/funnel/session-repository'
import { createFunnelSession } from '../server/managed-sites/funnel/session-service'
import { getManagedSitePriceCatalog, MANAGED_SITE_PRICE_CATALOG_VERSION, projectManagedSiteCatalogQuote } from '../server/managed-sites/ordering-service'
import { createContactInboxBindingMemoryRepository } from './fixtures/managed-site/contact-inbox-binding-repository'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'

const savedPrivateOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN

beforeAll(() => {
  ;(globalThis as any).defineEventHandler = defineEventHandler
  ;(globalThis as any).createError = createError
})

afterEach(() => {
  setManagedSiteContactInboxBindingDependenciesForTests(null)
  setManagedSiteFunnelRepositoryForTests(null)
  if (savedPrivateOrigin === undefined) delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
  else process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = savedPrivateOrigin
})

function session(status: ManagedSiteFunnelSession['status'] = 'active'): ManagedSiteFunnelSession {
  const now = new Date('2032-04-05T06:00:00.000Z')
  return {
    id: 41,
    sessionTokenHash: 'a'.repeat(64),
    status,
    currentStep: 5,
    answers: { modules: ['contact_lead_capture'] },
    consentSnapshot: null,
    previewId: null,
    previewAccessTokenHash: null,
    quoteId: null,
    leadIntentId: null,
    draftOrderId: null,
    projectId: null,
    releaseId: null,
    builtPreviewUrl: null,
    checkoutUrl: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
    createdAt: now,
    updatedAt: now,
  }
}

function configuredLine(status: ManagedSiteFunnelSession['status'] = 'active') {
  const memory = createContactInboxBindingMemoryRepository()
  const transport = createRecordingManagedSiteEmailTransport()
  let now = new Date('2032-04-05T06:00:00.000Z')
  const dependencies: ManagedSiteContactInboxBindingDependencies = {
    repository: memory.repository,
    transport,
    pepper: randomBytes(32).toString('hex'),
    clock: () => new Date(now),
  }
  return { memory, transport, dependencies, session: session(status), setNow(value: Date) { now = new Date(value) }, advance(milliseconds: number) { now = new Date(now.getTime() + milliseconds) }, now: () => new Date(now) }
}

function messageCode(text: string): string {
  const match = text.match(/\b\d{6}\b/u)
  if (!match) throw new Error('recording transport did not receive a verification code')
  return match[0]
}

describe('managed-site contact inbox binding', () => {
  it('registers a zero-cost automatic module without setup or monthly quote lines', async () => {
    const quote = projectManagedSiteCatalogQuote({ siteType: 'one_page', planKey: 'site_only', domainOption: 'existing', moduleKeys: ['contact_lead_capture'] })
    expect(quote.lines.some(line => line.lineKey === 'module-contact_lead_capture-setup')).toBe(false)
    expect(quote.lines.some(line => line.lineKey === 'monthly-module-contact_lead_capture')).toBe(false)
    const rows: any[] = []
    const repository = {
      async findModuleFulfilment() { return null },
      async insertModuleFulfilment(input: any) { const row = { ...input, id: 1, createdAt: new Date(), updatedAt: new Date() }; rows.push(row); return row },
      async listModuleFulfilmentsByDraftOrder() { return rows },
      async listPendingManualModuleFulfilments() { return [] },
      async closePendingManualModuleFulfilment() { return null },
    }
    const fulfilments = await createPaidManagedSiteModuleFulfilments(1, 2, { id: 3, moduleSnapshot: ['contact_lead_capture'] } as any, quote.lines, repository)
    expect(fulfilments).toEqual([expect.objectContaining({ moduleKey: 'contact_lead_capture', mode: 'automatic', status: 'automatic', billedMinor: 0 })])
  })

  it('fails closed before writing when the email transport is unconfigured', async () => {
    const line = configuredLine()
    const dependencies = { ...line.dependencies, transport: { configured: false, async send(): Promise<never> { throw new Error('must not send') } } }
    await expect(startManagedSiteContactInboxBinding({ session: line.session, email: 'hello@example.com' }, dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: expect.stringContaining('尚未開通') })
    expect(line.memory.state.bindings).toHaveLength(0)
    await expect(managedSiteContactInboxProjection(line.session.id, dependencies)).resolves.toEqual({ status: 'unbound', maskedEmail: null, resendAvailableAt: null, transportConfigured: false })
  })

  it('sends once, never projects the code or full address, and binds only after the correct code', async () => {
    const line = configuredLine()
    const email = 'hello@example.com'
    const started = await startManagedSiteContactInboxBinding({ session: line.session, email }, line.dependencies)
    expect(line.transport.messages).toHaveLength(1)
    expect(line.transport.messages[0]).toMatchObject({ to: email, subject: expect.stringContaining('驗證碼'), text: expect.stringContaining('10 分鐘') })
    const code = messageCode(line.transport.messages[0]!.text)
    const projection = await managedSiteContactInboxProjection(line.session.id, line.dependencies)
    expect(JSON.stringify(started)).not.toContain(code)
    expect(JSON.stringify(projection)).not.toContain(code)
    expect(JSON.stringify(started)).not.toContain(email)
    expect(JSON.stringify(projection)).not.toContain(email)
    expect(line.memory.state.bindings[0]!.codeHash).not.toBe(code)
    await expect(confirmManagedSiteContactInboxBinding({ session: line.session, code }, line.dependencies)).resolves.toEqual({ status: 'bound', maskedEmail: 'he***@example.com' })
    expect(line.memory.state.bindings[0]).toMatchObject({ status: 'bound', codeHash: null, codeExpiresAt: null, attemptCount: 0 })
  })

  it('locks after five wrong codes, rejects the old correct code, and recovers with a fresh send', async () => {
    const line = configuredLine()
    await startManagedSiteContactInboxBinding({ session: line.session, email: 'locks@example.com' }, line.dependencies)
    const firstCode = messageCode(line.transport.messages[0]!.text)
    for (let attempt = 1; attempt <= 5; attempt += 1) await expect(confirmManagedSiteContactInboxBinding({ session: line.session, code: firstCode === '999999' ? '888888' : '999999' }, line.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    expect(line.memory.state.bindings[0]).toMatchObject({ status: 'locked', attemptCount: 5, codeHash: null })
    await expect(confirmManagedSiteContactInboxBinding({ session: line.session, code: firstCode }, line.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    line.advance(61_000)
    await startManagedSiteContactInboxBinding({ session: line.session, email: 'locks@example.com' }, line.dependencies)
    const freshCode = messageCode(line.transport.messages[1]!.text)
    await expect(confirmManagedSiteContactInboxBinding({ session: line.session, code: freshCode }, line.dependencies)).resolves.toMatchObject({ status: 'bound' })
  })

  it('rejects an expired code with 409', async () => {
    const line = configuredLine()
    await startManagedSiteContactInboxBinding({ session: line.session, email: 'expire@example.com' }, line.dependencies)
    const code = messageCode(line.transport.messages[0]!.text)
    line.advance(10 * 60 * 1000 + 1)
    await expect(confirmManagedSiteContactInboxBinding({ session: line.session, code }, line.dependencies)).rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringContaining('重新寄送') })
  })

  it('enforces the persisted 60-second and five-per-hour send limits', async () => {
    const line = configuredLine()
    await startManagedSiteContactInboxBinding({ session: line.session, email: 'rate@example.com' }, line.dependencies)
    await expect(startManagedSiteContactInboxBinding({ session: line.session, email: 'rate@example.com' }, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: expect.stringContaining('最早可於') })
    for (let send = 2; send <= 5; send += 1) {
      line.advance(61_000)
      await startManagedSiteContactInboxBinding({ session: line.session, email: 'rate@example.com' }, line.dependencies)
    }
    line.advance(61_000)
    await expect(startManagedSiteContactInboxBinding({ session: line.session, email: 'rate@example.com' }, line.dependencies)).rejects.toMatchObject({ statusCode: 429, statusMessage: expect.stringContaining('最早可於') })
    expect(line.transport.messages).toHaveLength(5)
  })

  it('keeps A bound while B is pending, then atomically supersedes A after B confirms', async () => {
    const line = configuredLine()
    await startManagedSiteContactInboxBinding({ session: line.session, email: 'alpha@example.com' }, line.dependencies)
    await confirmManagedSiteContactInboxBinding({ session: line.session, code: messageCode(line.transport.messages[0]!.text) }, line.dependencies)
    line.advance(61_000)
    await startManagedSiteContactInboxBinding({ session: line.session, email: 'beta@example.com' }, line.dependencies)
    await expect(managedSiteContactInboxProjection(line.session.id, line.dependencies)).resolves.toMatchObject({ status: 'bound', maskedEmail: 'al***@example.com' })
    await confirmManagedSiteContactInboxBinding({ session: line.session, code: messageCode(line.transport.messages[1]!.text) }, line.dependencies)
    expect(line.memory.state.bindings.find(row => row.email === 'alpha@example.com')?.status).toBe('superseded')
    expect(line.memory.state.bindings.find(row => row.email === 'beta@example.com')?.status).toBe('bound')
  })

  it('rejects header injection before the transport is reached', async () => {
    const line = configuredLine()
    await expect(startManagedSiteContactInboxBinding({ session: line.session, email: 'a@b.com\nBcc: x@y.com' }, line.dependencies)).rejects.toMatchObject({ statusCode: 422 })
    expect(line.transport.messages).toHaveLength(0)
    expect(line.memory.state.bindings).toHaveLength(0)
  })

  it('supports both binding endpoints after purchase when the session is converted', async () => {
    const funnel = createFunnelSessionMemoryRepository()
    const created = await createFunnelSession(funnel.repository, () => new Date('2032-04-05T06:00:00.000Z'))
    funnel.state.sessions[0]!.status = 'converted'
    const line = configuredLine('converted')
    line.session.id = created.sessionId
    setManagedSiteFunnelRepositoryForTests(funnel.repository)
    setManagedSiteContactInboxBindingDependenciesForTests(line.dependencies)
    process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = 'https://funnel.test'
    const handler = (await import('../server/api/managed-sites/funnel/[...path]')).default
    const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, (error as any).statusCode || 500, (error as any).statusMessage); await send(event, JSON.stringify({ statusCode: (error as any).statusCode || 500, statusMessage: (error as any).statusMessage || 'Request failed.' }), 'application/json') } })
    const router = createRouter(); router.use('/api/managed-sites/funnel/**', handler); app.use(router)
    const request = async (suffix: string, body: unknown, method = 'POST') => toWebHandler(app)(new Request(`https://funnel.test/api/managed-sites/funnel/sessions/${created.sessionId}${suffix}`, { method, headers: { 'content-type': 'application/json', origin: 'https://funnel.test', 'x-managed-site-funnel-token': created.sessionToken }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }))
    const started = await request('/inbox-binding', { email: 'converted@example.com' })
    expect(started.status).toBe(200)
    const code = messageCode(line.transport.messages[0]!.text)
    const confirmed = await request('/inbox-binding-confirm', { code })
    expect(confirmed.status).toBe(200)
    const projected = await request('', {}, 'GET')
    expect(await projected.json()).toMatchObject({ status: 'converted', contactInbox: { status: 'bound', maskedEmail: 'co***@example.com' } })
  })

  it('publishes fifteen modules under pricing catalog v6', () => {
    expect(getManagedSitePriceCatalog().modules).toHaveLength(15)
    expect(MANAGED_SITE_PRICE_CATALOG_VERSION).toBe('managed-site-pricing-twd-v6')
  })
})
