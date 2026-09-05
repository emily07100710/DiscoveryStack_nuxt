import { createHash, randomBytes } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import type { ManagedSiteContactInboxBinding, ManagedSiteContactSubmission, ManagedSiteProject } from '../server/database/schema'
import { buildSiteSpec } from '../server/managed-sites/site-spec'
import { createDeterministicManagedSiteBlueprint } from '../server/managed-sites/live-connectors/adapters'
import { compileManagedSiteBlueprint, validateManagedSiteBlueprintProviderOutput } from '../server/managed-sites/live-connectors/blueprint'
import { buildManagedSiteGenerationRequest } from '../server/managed-sites/live-connectors/generation-service'
import { createRecordingManagedSiteEmailTransport, type ManagedSiteEmailTransport } from '../server/managed-sites/contact-inbox/email-transport'
import { createManagedSiteContactFormRateLimiter, setManagedSiteContactFormDependenciesForTests, type ManagedSiteContactFormDependencies } from '../server/managed-sites/contact-form/ingest-service'
import { deriveManagedSiteContactFormToken } from '../server/managed-sites/contact-form/token-service'
import type { ManagedSiteContactFormRepository } from '../server/managed-sites/contact-form/repository'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { decidePublicCors } from '../server/utils/publicCors'
import { renderManagedSiteStaticAssets } from '../server/managed-sites/live-connectors/internal-broker/static-renderer'

const savedOrigin = process.env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN
const savedPepper = process.env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER

beforeAll(() => {
  ;(globalThis as any).defineEventHandler = defineEventHandler
  ;(globalThis as any).createError = createError
})

afterEach(() => {
  setManagedSiteContactFormDependenciesForTests(null)
  if (savedOrigin === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN
  else process.env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN = savedOrigin
  if (savedPepper === undefined) delete process.env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER
  else process.env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER = savedPepper
  vi.restoreAllMocks()
})

function project(id = 71): ManagedSiteProject {
  const now = new Date('2034-02-03T04:05:06.000Z')
  return {
    id, ownerUserId: 8, canonicalClientIdentity: '測試品牌', canonicalWebsiteIdentity: 'https://customer.example', contentOperationClientId: null,
    status: 'active', siteType: 'brand_blog', activeVersionId: 91, catalogVersion: 'managed-site-catalog-v1', subscriptionReference: null,
    contactFormTokenVersion: 1, contactFormTokenHash: null, projectFingerprint: 'a'.repeat(64), creationIdempotencyKey: 'contact-form-project', createdAt: now, updatedAt: now,
  }
}

function memoryRepository(row: ManagedSiteProject, tokenHash: string) {
  row.contactFormTokenHash = tokenHash
  const state: { projects: ManagedSiteProject[]; bindings: ManagedSiteContactInboxBinding[]; submissions: ManagedSiteContactSubmission[]; nextId: number } = { projects: [row], bindings: [], submissions: [], nextId: 1 }
  const repository: ManagedSiteContactFormRepository = {
    async findProjectByTokenHash(hash) { return state.projects.find(item => item.contactFormTokenHash === hash) || null },
    async findBoundInbox(projectId) { return state.bindings.filter(item => item.projectId === projectId && item.status === 'bound').sort((a, b) => b.id - a.id)[0] || null },
    async findRecentDuplicate(dedupeKey, since) { return state.submissions.find(item => item.dedupeKey === dedupeKey && item.createdAt.getTime() > since.getTime()) || null },
    async insertSubmission(input) { const stored = { ...structuredClone(input), id: state.nextId++, createdAt: new Date('2034-02-03T04:05:06.000Z') } as ManagedSiteContactSubmission; state.submissions.push(stored); return stored },
    async updateSubmission(id, patch) { const stored = state.submissions.find(item => item.id === id); if (!stored) return null; Object.assign(stored, structuredClone(patch)); return stored },
  }
  return { repository, state }
}

function boundInbox(projectId: number, email = 'bound-inbox@example.com'): ManagedSiteContactInboxBinding {
  const now = new Date('2034-02-03T04:00:00.000Z')
  return { id: 10, funnelSessionId: 20, projectId, email, status: 'bound', codeHash: null, codeExpiresAt: null, attemptCount: 0, sendCount: 1, lastSentAt: now, boundAt: now, createdAt: now, updatedAt: now }
}

async function line(options: { bound?: boolean; transport?: ManagedSiteEmailTransport } = {}) {
  process.env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN = 'https://ingest.example'
  process.env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER = randomBytes(32).toString('hex')
  const row = project()
  const token = deriveManagedSiteContactFormToken(row.id, row.contactFormTokenVersion)!
  const memory = memoryRepository(row, createHash('sha256').update(token).digest('hex'))
  if (options.bound) memory.state.bindings.push(boundInbox(row.id))
  const transport = options.transport || createRecordingManagedSiteEmailTransport()
  const dependencies: ManagedSiteContactFormDependencies = { repository: memory.repository, transport, rateLimiter: createManagedSiteContactFormRateLimiter(), clock: () => new Date('2034-02-03T04:05:06.000Z') }
  setManagedSiteContactFormDependenciesForTests(dependencies)
  const handler = (await import('../server/api/managed-sites/site-forms/[...path]')).default
  const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, (error as any).statusCode || 500, (error as any).statusMessage); await send(event, JSON.stringify({ statusCode: (error as any).statusCode || 500, statusMessage: (error as any).statusMessage || 'Request failed.' }), 'application/json') } })
  const router = createRouter(); router.use('/api/managed-sites/site-forms/**', handler); app.use(router)
  const request = (body: string, requestOptions: { token?: string; contentType?: string; userAgent?: string } = {}) => toWebHandler(app)(new Request(`https://ingest.example/api/managed-sites/site-forms/${requestOptions.token || token}/submit`, { method: 'POST', redirect: 'manual', headers: { 'content-type': requestOptions.contentType || 'application/x-www-form-urlencoded', 'user-agent': requestOptions.userAgent || 'contact-form-test' }, body }))
  return { ...memory, transport, token, request }
}

function form(overrides: Partial<Record<string, string>> = {}) {
  return new URLSearchParams({ name: '王小明', email: 'visitor@example.com', phone: '0912345678', message: '我想了解網站服務。', companyFax: '', ...overrides }).toString()
}

describe('managed-site contact form ingest', () => {
  it('returns 404 for an unknown token and stores nothing', async () => {
    const current = await line()
    const response = await current.request(form(), { token: 'f'.repeat(64) })
    expect(response.status).toBe(404)
    expect(current.state.submissions).toHaveLength(0)
  })

  it('gives the honeypot the same success redirect while storing nothing', async () => {
    const current = await line()
    const bot = await current.request(form({ companyFax: 'filled by bot' }))
    expect(bot.status).toBe(303)
    expect(bot.headers.get('location')).toBe('https://customer.example/thanks?sent=1')
    expect(current.state.submissions).toHaveLength(0)
    const visitor = await current.request(form({ message: 'real visitor' }))
    expect(visitor.status).toBe(bot.status)
    expect(visitor.headers.get('location')).toBe(bot.headers.get('location'))
  })

  it('stores without a bound inbox, marks forwarding failed, and still succeeds', async () => {
    const current = await line()
    const response = await current.request(form())
    expect(response.status).toBe(303)
    expect(current.state.submissions).toHaveLength(1)
    expect(current.state.submissions[0]).toMatchObject({ status: 'forward_failed', forwardErrorCode: 'no_bound_inbox', forwardTargetEmail: null })
  })

  it('forwards exactly once to the bound inbox, not the submitter, and marks the row forwarded', async () => {
    const current = await line({ bound: true })
    const response = await current.request(form({ message: '請寄產品資料給我。' }))
    const messages = (current.transport as ReturnType<typeof createRecordingManagedSiteEmailTransport>).messages
    expect(response.status).toBe(303)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ to: 'bound-inbox@example.com', replyTo: 'visitor@example.com', text: expect.stringContaining('請寄產品資料給我。') })
    expect(messages[0]!.to).not.toBe('visitor@example.com')
    expect(current.state.submissions[0]).toMatchObject({ status: 'forwarded', forwardTargetEmail: 'bound-inbox@example.com', forwardErrorCode: null })
  })

  it('persists and marks the row failed when transport throws without returning 500', async () => {
    const transport: ManagedSiteEmailTransport = { configured: true, async send() { throw new Error('synthetic provider rejection') } }
    const current = await line({ bound: true, transport })
    const response = await current.request(form())
    expect(response.status).toBe(303)
    expect(current.state.submissions).toHaveLength(1)
    expect(current.state.submissions[0]).toMatchObject({ status: 'forward_failed', forwardErrorCode: 'provider_rejected' })
  })

  it('rejects oversized and JSON bodies before storage', async () => {
    const current = await line()
    const oversized = await current.request(`name=x&email=x%40example.com&message=${'x'.repeat(17_000)}&companyFax=`)
    expect(oversized.status).toBe(413)
    const json = await current.request(JSON.stringify({ name: 'x' }), { contentType: 'application/json' })
    expect(json.status).toBe(415)
    expect(current.state.submissions).toHaveLength(0)
  })

  it.each([{ name: '王小明\r\nBcc: victim@example.com' }, { email: 'visitor@example.com\r\nBcc: victim@example.com' }])('rejects CR/LF before calling transport', async injected => {
    const transport = createRecordingManagedSiteEmailTransport()
    const current = await line({ bound: true, transport })
    const response = await current.request(form(injected))
    expect(response.status).toBe(422)
    expect(transport.messages).toHaveLength(0)
    expect(current.state.submissions).toHaveLength(0)
  })

  it('rate limits the sixth submission from one fingerprint within an hour', async () => {
    const current = await line()
    for (let index = 1; index <= 5; index += 1) expect((await current.request(form({ message: `message ${index}` }))).status).toBe(303)
    expect((await current.request(form({ message: 'message 6' }))).status).toBe(429)
    expect(current.state.submissions).toHaveLength(5)
  })

  it('deduplicates an identical submission inside fifteen minutes', async () => {
    const current = await line()
    expect((await current.request(form())).status).toBe(303)
    expect((await current.request(form())).status).toBe(303)
    expect(current.state.submissions).toHaveLength(1)
  })

  it('derives the redirect only from the stored project URL', async () => {
    const current = await line()
    const body = `${form()}&redirect=https%3A%2F%2Fevil.example%2Fstolen`
    const response = await current.request(body)
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://customer.example/thanks?sent=1')
  })
})

function contactRequest() {
  const spec = buildSiteSpec({ draftIdentity: 'contact-blueprint', brandName: 'Contact Blueprint', audience: 'Taiwan customers', brief: 'A deterministic contact site.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['contact_lead_capture'], styleReferences: [] }, new Date('2034-02-03T00:00:00.000Z'))
  return buildManagedSiteGenerationRequest(1, 71, 91, 'a'.repeat(64), spec, 'astro', 'contact-blueprint-request')
}

describe('managed-site contact form blueprint and CORS invariants', () => {
  it('blocks a form endpoint on any origin other than the configured ingest origin', () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN = 'https://ingest.example'
    process.env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER = randomBytes(32).toString('hex')
    const request = contactRequest()
    const blueprint = createDeterministicManagedSiteBlueprint(request)
    const section = blueprint.pages.flatMap(page => page.sections).find(item => item.kind === 'contact_form')!
    section.formEndpoint = section.formEndpoint!.replace('https://ingest.example', 'https://evil.example')
    const output = { schemaVersion: 'managed-site-blueprint-provider-response-v1', providerKey: 'mock-generator', providerModel: 'mock-v1', providerRequestId: 'contact-blueprint-provider', requestFingerprint: request.requestFingerprint, blueprint, blueprintHash: stableFingerprint(blueprint) }
    expect(() => validateManagedSiteBlueprintProviderOutput(output, request, 'mock-generator')).toThrow()
  })

  it('renders the selected module in honest demo mode without an action when ingest is unconfigured', () => {
    delete process.env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN
    process.env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER = randomBytes(32).toString('hex')
    const request = contactRequest()
    const blueprint = createDeterministicManagedSiteBlueprint(request)
    const section = blueprint.pages.flatMap(page => page.sections).find(item => item.kind === 'contact_form')!
    expect(section.formEndpoint).toBeNull()
    const contact = compileManagedSiteBlueprint(blueprint).find(file => file.path === 'src/pages/contact.astro')!.content
    expect(contact).toContain('示意表單：網站正式上線並完成收信信箱綁定後才會真的送出。')
    expect(contact).not.toContain('action=')
    expect(compileManagedSiteBlueprint(blueprint).some(file => file.path === 'src/pages/thanks.astro')).toBe(true)
  })

  it('generates the identical deterministic form endpoint for the same project twice', () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN = 'https://ingest.example'
    process.env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER = randomBytes(32).toString('hex')
    const first = createDeterministicManagedSiteBlueprint(contactRequest())
    const second = createDeterministicManagedSiteBlueprint(contactRequest())
    const endpoint = (blueprint: typeof first) => blueprint.pages.flatMap(page => page.sections).find(item => item.kind === 'contact_form')!.formEndpoint
    expect(endpoint(first)).toMatch(/^https:\/\/ingest\.example\/api\/managed-sites\/site-forms\/[a-f0-9]{64}\/submit$/u)
    expect(endpoint(second)).toBe(endpoint(first))
    const deployedContact = renderManagedSiteStaticAssets(first).find(asset => asset.path === 'contact/index.html')!.content
    expect(deployedContact).toContain(`<form class="contact-form" method="post" action="${endpoint(first)}"`)
    expect(deployedContact).not.toContain('<script')
    expect(renderManagedSiteStaticAssets(first).some(asset => asset.path === 'thanks/index.html')).toBe(true)
  })

  it('keeps the ingest path outside the public CORS target surface', () => {
    expect(decidePublicCors({ path: `/api/managed-sites/site-forms/${'a'.repeat(64)}/submit`, method: 'POST', origin: 'https://customer.example', configuredOrigin: 'https://public.example' }).reason).toBe('not-target')
  })
})
