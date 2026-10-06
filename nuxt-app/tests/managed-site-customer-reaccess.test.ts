import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createRecordingManagedSiteEmailTransport, type ManagedSiteEmailTransport } from '../server/managed-sites/contact-inbox/email-transport'
import { tokenHash } from '../server/managed-sites/normalization'
import {
  MANAGED_SITE_REACCESS_PATH,
  managedSiteReaccessConfiguration,
  requestManagedSiteReaccess,
  type ManagedSiteReaccessDependencies,
} from '../server/managed-sites/reaccess-service'
import { acceptManagedSiteInvitation, createManagedSiteProject, inviteManagedSiteMember } from '../server/managed-sites/service'
import { requireManagedSiteCustomer } from '../server/managed-sites/auth'
import { MANAGED_SITE_SESSION_COOKIE, MANAGED_SITE_SESSION_TTL_MS, type ManagedSiteActor } from '../server/managed-sites/types'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import {
  MANAGED_SITE_ACCESS_PATH,
  enforceManagedSiteAccessRateLimit,
  renderManagedSiteAccessAcknowledgementPage,
  renderManagedSiteAccessConfirmPage,
  renderManagedSiteAccessExpiredPage,
  renderManagedSiteAccessRequestPage,
  resetManagedSiteAccessRateLimitForTests,
} from '../server/utils/managedSiteAccessPage'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'

const OWNER_USER_ID = 1
const CUSTOMER = 'customer@acme.taipei'
const PORTAL_ORIGIN = 'https://ops.discoverystack.example'
const ROOT = process.cwd()

const ownerActor: ManagedSiteActor = {
  ownerUserId: OWNER_USER_ID,
  actorUserId: OWNER_USER_ID,
  authority: 'owner_session',
  role: 'owner',
  principal: `owner-${OWNER_USER_ID}@internal.invalid`,
}

type MemoryRepository = ReturnType<typeof createManagedSiteMemoryRepository>

async function seed(projects = 1) {
  const managed = createManagedSiteMemoryRepository()
  const projectIds: number[] = []
  for (let index = 0; index < projects; index += 1) {
    const created = await createManagedSiteProject(OWNER_USER_ID, ownerActor, {
      canonicalClientIdentity: `reaccess-client-${index}`,
      canonicalWebsiteIdentity: `reaccess-${index}.example.com`,
      siteType: 'one_page',
      idempotencyKey: `reaccess-project-${index}`,
    }, managed.repository)
    await inviteManagedSiteMember(OWNER_USER_ID, created.project.id, ownerActor, {
      email: CUSTOMER,
      role: 'editor',
      idempotencyKey: `reaccess-invite-${index}`,
    }, managed.repository)
    projectIds.push(created.project.id)
  }
  // Start from a clean link history: the owner's onboarding invitation is not what
  // this feature throttles on.
  managed.state.invitations.length = 0
  return { managed, projectIds }
}

function dependencies(managed: MemoryRepository, overrides: Partial<ManagedSiteReaccessDependencies> = {}): ManagedSiteReaccessDependencies {
  return {
    repository: managed.repository,
    emailTransport: createRecordingManagedSiteEmailTransport(),
    resolveOwnerUserId: async () => OWNER_USER_ID,
    portalOrigin: PORTAL_ORIGIN,
    clock: () => new Date(),
    ...overrides,
  }
}

function tokensFrom(transport: { readonly messages: readonly { text: string }[] }): string[] {
  return transport.messages.flatMap(message => [...message.text.matchAll(/token=([A-Za-z0-9_%-]+)/gu)].map(match => decodeURIComponent(match[1]!)))
}

beforeEach(() => {
  resetManagedSiteAccessRateLimitForTests()
})

describe('managed-site customer self-serve re-access', () => {
  it('mails a single-use link to an address that already holds access, storing only its hash', async () => {
    const { managed, projectIds } = await seed()
    const transport = createRecordingManagedSiteEmailTransport()
    const membershipsBefore = managed.state.memberships.length

    const result = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { emailTransport: transport }))

    expect(result.acknowledged).toBe(true)
    expect(result.diagnostics).toMatchObject({ outcome: 'sent', issued: 1 })
    expect(transport.messages).toHaveLength(1)
    expect(transport.messages[0]!.to).toBe(CUSTOMER)
    expect(transport.messages[0]!.idempotencyKey).toMatch(/^managed-site-reaccess:[a-f0-9]{64}$/u)
    expect(transport.messages[0]!.text).toContain(`${PORTAL_ORIGIN}${MANAGED_SITE_REACCESS_PATH}?token=`)

    // Re-access re-issues a link; it must never widen who has access.
    expect(managed.state.memberships).toHaveLength(membershipsBefore)
    expect(managed.state.invitations).toHaveLength(1)
    expect(managed.state.invitations[0]).toMatchObject({
      ownerUserId: OWNER_USER_ID,
      projectId: projectIds[0],
      recipientEmail: CUSTOMER,
      role: 'editor',
      status: 'pending',
    })

    const [token] = tokensFrom(transport)
    expect(token).toBeTruthy()
    expect(managed.state.invitations[0]!.tokenHash).toBe(tokenHash(token!))
    expect(JSON.stringify(managed.state)).not.toContain(token!)
  })

  it('gives the link a 30 minute life, far shorter than an owner invitation', async () => {
    const { managed } = await seed()
    const at = new Date('2026-03-01T00:00:00.000Z')
    await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { clock: () => at }))
    expect(managed.state.invitations[0]!.expiresAt.getTime() - at.getTime()).toBe(30 * 60_000)
    expect(managed.state.invitations[0]!.createdAt.getTime()).toBe(at.getTime())
  })

  it('records the issue in the audit ledger by fingerprint, never by raw address', async () => {
    const { managed } = await seed()
    await requestManagedSiteReaccess(CUSTOMER, dependencies(managed))

    const issued = managed.state.audits.filter(row => row.action === 'managed_site_reaccess_link_issued')
    expect(issued).toHaveLength(1)
    expect(issued[0]!.authority).toBe('customer_session')
    const metadata = JSON.stringify(issued[0]!.metadata)
    expect(metadata).toContain(stableFingerprint({ recipientEmail: CUSTOMER }))
    expect(metadata).not.toContain(CUSTOMER)
    expect(metadata).not.toContain('acme.taipei')
  })

  it('opens the customer session through the normal accept path and burns the link', async () => {
    const { managed, projectIds } = await seed()
    const transport = createRecordingManagedSiteEmailTransport()
    await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { emailTransport: transport }))
    const [token] = tokensFrom(transport)

    const accepted = await acceptManagedSiteInvitation(token!, managed.repository)
    expect(accepted.project.id).toBe(projectIds[0])
    expect(accepted.session.sessionHash).toBe(tokenHash(accepted.sessionToken))
    expect(accepted.session.expiresAt.getTime() - accepted.session.lastSeenAt!.getTime()).toBe(MANAGED_SITE_SESSION_TTL_MS)
    expect(managed.state.invitations[0]!.status).toBe('accepted')

    await expect(acceptManagedSiteInvitation(token!, managed.repository)).rejects.toMatchObject({ statusCode: 404 })
    expect(managed.state.sessions).toHaveLength(1)
  })

  it('issues nothing for an unknown address, a revoked member, or the platform owner principal', async () => {
    const { managed, projectIds } = await seed()

    const unknown = await requestManagedSiteReaccess('nobody@acme.taipei', dependencies(managed))
    expect(unknown.diagnostics).toMatchObject({ outcome: 'no_active_membership' })

    // The owner row is a platform principal, active on the same project, and must
    // never become a self-serve identity.
    expect(managed.state.memberships.some(row => row.principalEmail === ownerActor.principal && row.role === 'owner' && row.status === 'active')).toBe(true)
    const platformOwner = await requestManagedSiteReaccess(ownerActor.principal!, dependencies(managed))
    expect(platformOwner.diagnostics).toMatchObject({ outcome: 'no_active_membership' })

    const membership = managed.state.memberships.find(row => row.projectId === projectIds[0] && row.principalEmail === CUSTOMER)!
    await managed.repository.updateMembership(OWNER_USER_ID, membership.id, { status: 'revoked', revokedAt: new Date() } as any)
    const revoked = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed))
    expect(revoked.diagnostics).toMatchObject({ outcome: 'no_active_membership' })

    expect(managed.state.invitations).toHaveLength(0)
  })

  it('acknowledges an unusable address without touching the ledger', async () => {
    const { managed } = await seed()
    for (const value of ['', '   ', 'not-an-email', `${'a'.repeat(330)}@acme.taipei`, 42, null, undefined, { email: CUSTOMER }]) {
      const result = await requestManagedSiteReaccess(value, dependencies(managed))
      expect(result).toEqual({ acknowledged: true, diagnostics: { outcome: 'invalid_email' } })
    }
    expect(managed.state.invitations).toHaveLength(0)
    expect(managed.state.audits.filter(row => String(row.action).startsWith('managed_site_reaccess'))).toHaveLength(0)
  })

  it('answers every address with the identical acknowledgement, so customers cannot be enumerated', async () => {
    const { managed } = await seed()
    const known = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed))
    const unknown = await requestManagedSiteReaccess('nobody@acme.taipei', dependencies(managed))
    expect(known.acknowledged).toEqual(unknown.acknowledged)

    // The page shown after a submit takes no input at all, so it is structurally
    // incapable of differing between one address and another.
    expect(renderManagedSiteAccessAcknowledgementPage.length).toBe(0)
    expect(renderManagedSiteAccessAcknowledgementPage()).toEqual(renderManagedSiteAccessAcknowledgementPage())
    expect(renderManagedSiteAccessAcknowledgementPage()).not.toContain(CUSTOMER)

    // And the route throws the per-address truth away rather than shaping a reply from it.
    const route = readFileSync(join(ROOT, 'server/routes/managed-site-access.post.ts'), 'utf8')
    expect(route).toContain('await requestManagedSiteReaccess(email)')
    expect(route).not.toMatch(/\breturn\s+await\s+requestManagedSiteReaccess|=\s*await\s+requestManagedSiteReaccess/)
    expect(route).not.toContain('.diagnostics')
    expect(route).toContain('renderManagedSiteAccessAcknowledgementPage()')
  })

  it('spaces links out per address and caps them per hour', async () => {
    const { managed } = await seed()
    let current = new Date('2026-03-01T00:00:00.000Z')
    const transport = createRecordingManagedSiteEmailTransport()
    const send = () => requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { emailTransport: transport, clock: () => current }))

    expect((await send()).diagnostics).toMatchObject({ outcome: 'sent' })

    const immediate = await send()
    expect(immediate.diagnostics).toMatchObject({ outcome: 'throttled' })
    expect((immediate.diagnostics as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(60)
    expect(managed.state.invitations).toHaveLength(1)

    current = new Date(current.getTime() + 5 * 60_000)
    expect((await send()).diagnostics).toMatchObject({ outcome: 'sent' })
    current = new Date(current.getTime() + 5 * 60_000)
    expect((await send()).diagnostics).toMatchObject({ outcome: 'sent' })

    current = new Date(current.getTime() + 5 * 60_000)
    expect((await send()).diagnostics).toMatchObject({ outcome: 'throttled' })
    expect(managed.state.invitations).toHaveLength(3)
    expect(transport.messages).toHaveLength(3)

    // Once the hour has rolled past the oldest link, the customer is served again.
    current = new Date(current.getTime() + 61 * 60_000)
    expect((await send()).diagnostics).toMatchObject({ outcome: 'sent' })
    expect(managed.state.invitations).toHaveLength(4)
  })

  it('leaves no usable link behind when the mail provider fails, and allows an immediate retry', async () => {
    const { managed } = await seed()
    const failing: ManagedSiteEmailTransport = { configured: true, async send() { throw new Error('provider down') } }
    const at = new Date('2026-03-01T00:00:00.000Z')

    const failed = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { emailTransport: failing, clock: () => at }))
    expect(failed.diagnostics).toMatchObject({ outcome: 'delivery_failed', issued: 1 })
    expect(managed.state.invitations).toHaveLength(1)
    expect(managed.state.invitations[0]!.status).toBe('revoked')
    expect(managed.state.audits.some(row => row.action === 'managed_site_reaccess_link_voided')).toBe(true)

    // Same instant, so only the revoked row could have blocked this retry.
    const transport = createRecordingManagedSiteEmailTransport()
    const retry = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { emailTransport: transport, clock: () => at }))
    expect(retry.diagnostics).toMatchObject({ outcome: 'sent' })

    // The mailed link is the live row; the voided one is a different token entirely.
    const [token] = tokensFrom(transport)
    const dead = managed.state.invitations.find(row => row.status === 'revoked')!
    const live = managed.state.invitations.find(row => row.status === 'pending')!
    expect(dead.tokenHash).not.toBe(tokenHash(token!))
    expect(live.tokenHash).toBe(tokenHash(token!))
    expect(await managed.repository.findInvitationByTokenHash(dead.tokenHash)).toMatchObject({ status: 'revoked' })
  })

  it('sends one email covering every site the address can manage', async () => {
    const { managed, projectIds } = await seed(2)
    const transport = createRecordingManagedSiteEmailTransport()
    const result = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { emailTransport: transport }))

    expect(result.diagnostics).toMatchObject({ outcome: 'sent', issued: 2 })
    expect(transport.messages).toHaveLength(1)
    expect(transport.messages[0]!.text).toContain('reaccess-0.example.com')
    expect(transport.messages[0]!.text).toContain('reaccess-1.example.com')
    expect(tokensFrom(transport)).toHaveLength(2)
    expect([...new Set(tokensFrom(transport))]).toHaveLength(2)
    expect(managed.state.invitations.map(row => row.projectId).sort()).toEqual([...projectIds].sort())
  })

  it('stays inert, and issues nothing, until the link origin and mail provider are configured', async () => {
    const { managed } = await seed()

    const noOrigin = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { portalOrigin: '' }))
    expect(noOrigin.diagnostics).toMatchObject({ outcome: 'not_configured', missing: 'portal_origin' })

    const noTransport = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, {
      emailTransport: { configured: false, async send() { throw new Error('unavailable') } },
    }))
    expect(noTransport.diagnostics).toMatchObject({ outcome: 'not_configured', missing: 'email_transport' })

    expect(managed.state.invitations).toHaveLength(0)
    expect(managedSiteReaccessConfiguration({ portalOrigin: '', emailTransport: createRecordingManagedSiteEmailTransport() }).ready).toBe(false)
    expect(managedSiteReaccessConfiguration({ portalOrigin: PORTAL_ORIGIN, emailTransport: createRecordingManagedSiteEmailTransport() }).ready).toBe(true)
  })

  it('refuses a link host that is not an exact configured HTTPS origin', async () => {
    const { managed } = await seed()
    const rejected = [
      'http://ops.discoverystack.example',
      'https://ops.discoverystack.example/portal',
      'https://ops.discoverystack.example/?next=/',
      'https://user:pass@ops.discoverystack.example',
      'https://localhost:3000',
      'not-a-url',
      'javascript:alert(1)',
    ]
    for (const origin of rejected) {
      const result = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, { portalOrigin: origin, nodeEnv: 'production' }))
      expect(result.diagnostics, origin).toMatchObject({ outcome: 'not_configured', missing: 'portal_origin' })
    }
    expect(managed.state.invitations).toHaveLength(0)
  })

  it('answers neutrally when the platform itself is unreachable', async () => {
    const { managed } = await seed()
    const result = await requestManagedSiteReaccess(CUSTOMER, dependencies(managed, {
      resolveOwnerUserId: async () => { throw new Error('database offline') },
    }))
    expect(result).toEqual({ acknowledged: true, diagnostics: { outcome: 'platform_unavailable' } })
  })
})

describe('managed-site re-access pages and client throttle', () => {
  it('never consumes the token on a GET, so mail scanners cannot burn the link', () => {
    const source = readFileSync(join(ROOT, 'server/routes/managed-site-access.get.ts'), 'utf8')
    expect(source).not.toContain('acceptManagedSiteInvitation')
    expect(source).not.toContain('setManagedSiteSessionCookie')
    expect(source).toContain('renderManagedSiteAccessConfirmPage')
    expect(renderManagedSiteAccessConfirmPage('a'.repeat(43))).toContain('method="post"')
  })

  it('escapes anything that arrives in the token or the submitted address', () => {
    const hostile = '"><script>alert(1)</script>'
    const confirm = renderManagedSiteAccessConfirmPage(hostile)
    expect(confirm).not.toContain('<script>alert(1)')
    expect(confirm).toContain('&lt;script&gt;')
    expect(renderManagedSiteAccessRequestPage({ email: hostile, message: hostile })).not.toContain('<script>alert(1)')
    expect(renderManagedSiteAccessExpiredPage(hostile)).not.toContain('<script>alert(1)')
  })

  it('marks every page noindex and keeps it out of shared caches', () => {
    const pages = [
      renderManagedSiteAccessRequestPage(),
      renderManagedSiteAccessAcknowledgementPage(),
      renderManagedSiteAccessConfirmPage('b'.repeat(43)),
      renderManagedSiteAccessExpiredPage(),
    ]
    for (const html of pages) {
      expect(html).toContain('name="robots" content="noindex, nofollow, noarchive"')
      expect(html).toContain('name="referrer" content="origin"')
    }
    for (const file of ['server/routes/managed-site-access.get.ts', 'server/routes/managed-site-access.post.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toContain('managedSiteAccessPageHeaders')
    }
    const get = readFileSync(join(ROOT, 'server/routes/managed-site-access.get.ts'), 'utf8')
    expect(get).toContain("'Cache-Control', 'private, no-store, max-age=0'")
    expect(get).toContain("'X-Robots-Tag', 'noindex, nofollow, noarchive'")
  })

  /**
   * Regression guard for a real 403 seen in a browser. These pages POST their own
   * forms, and a document whose referrer policy is `no-referrer` makes the browser
   * send `Origin: null` on that submit, which assertSameOriginManagedSiteMutation
   * rejects. Verified against Chrome: `no-referrer` -> `Origin: null`;
   * `origin` -> a real Origin with the token stripped from the Referer.
   */
  it('never sets a referrer policy that would blank the Origin header on its own form submit', () => {
    const pages = [
      renderManagedSiteAccessRequestPage(),
      renderManagedSiteAccessAcknowledgementPage(),
      renderManagedSiteAccessConfirmPage('c'.repeat(43)),
      renderManagedSiteAccessExpiredPage(),
    ]
    for (const html of pages) expect(html).not.toContain('content="no-referrer"')
    const get = readFileSync(join(ROOT, 'server/routes/managed-site-access.get.ts'), 'utf8')
    expect(get).toContain("setHeader(event, 'Referrer-Policy', 'origin')")
    expect(get).not.toContain("'Referrer-Policy', 'no-referrer'")
  })

  /**
   * The emailed link, the form action and the 401 recovery hint must always agree.
   * A second literal would keep working in tests and silently break real emails the
   * day the route is renamed, so the path is asserted to exist exactly once.
   */
  it('spells the re-access path in exactly one place', () => {
    expect(MANAGED_SITE_REACCESS_PATH).toBe(MANAGED_SITE_ACCESS_PATH)
    const sources = [
      'server/managed-sites/types.ts',
      'server/managed-sites/reaccess-service.ts',
      'server/managed-sites/auth.ts',
      'server/utils/managedSiteAccessPage.ts',
      'server/routes/managed-site-access.get.ts',
      'server/routes/managed-site-access.post.ts',
    ]
    const literals = sources.flatMap(file => (readFileSync(join(ROOT, file), 'utf8').match(/'\/managed-site-access'/g) || []).map(() => file))
    expect(literals, `expected one literal, found in: ${literals.join(', ')}`).toHaveLength(1)
    expect(literals[0]).toBe('server/managed-sites/types.ts')
  })

  it('tells an expired customer session where to recover, and drops the dead cookie', async () => {
    const auth = readFileSync(join(ROOT, 'server/managed-sites/auth.ts'), 'utf8')
    expect(auth).toContain('data: { reaccessPath: MANAGED_SITE_REACCESS_PATH }')
    // A cookie whose session row is gone can never succeed again; leaving it set
    // makes the browser replay it on every request.
    expect(auth).toContain('clearManagedSiteSessionCookie(event)')

    const managed = createManagedSiteMemoryRepository()
    const headers: string[] = []
    const event = {
      node: { req: { headers: { cookie: `${MANAGED_SITE_SESSION_COOKIE}=${'d'.repeat(43)}` } }, res: { getHeader: () => undefined, setHeader: (name: string, value: unknown) => { headers.push(`${name}: ${String(value)}`) }, removeHeader: () => {} } },
    } as any
    let thrown: any
    try { await requireManagedSiteCustomer(event, managed.repository) } catch (error) { thrown = error }
    expect(thrown?.statusCode).toBe(401)
    expect(thrown?.data).toEqual({ reaccessPath: MANAGED_SITE_REACCESS_PATH })
    expect(headers.join('\n')).toContain(MANAGED_SITE_SESSION_COOKIE)
  })

  it('answers a missing and an expired session identically, so neither is a probe', async () => {
    const managed = createManagedSiteMemoryRepository()
    const missing = { node: { req: { headers: {} }, res: { getHeader: () => undefined, setHeader: () => {}, removeHeader: () => {} } } } as any
    let thrown: any
    try { await requireManagedSiteCustomer(missing, managed.repository) } catch (error) { thrown = error }
    expect(thrown?.statusCode).toBe(401)
    expect(thrown?.statusMessage).toBe('Managed site customer access requires a valid invitation session.')
    expect(thrown?.data).toEqual({ reaccessPath: MANAGED_SITE_REACCESS_PATH })
  })

  it('requires a same-origin submit on the page route, so a foreign form cannot drive it', () => {
    const source = readFileSync(join(ROOT, 'server/routes/managed-site-access.post.ts'), 'utf8')
    expect(source).toContain('assertSameOriginManagedSiteMutation(event)')
    expect(source).toContain('enforceManagedSiteAccessRateLimit')
    expect(source).toContain('requestFingerprint(event)')
  })

  it('throttles one client without affecting another, and lets the window roll forward', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(() => enforceManagedSiteAccessRateLimit('client-a'), `attempt ${attempt}`).not.toThrow()
    }
    let thrown: any
    try { enforceManagedSiteAccessRateLimit('client-a') } catch (error) { thrown = error }
    expect(thrown?.statusCode).toBe(429)

    expect(() => enforceManagedSiteAccessRateLimit('client-b')).not.toThrow()
    expect(() => enforceManagedSiteAccessRateLimit('client-a', Date.now() + 16 * 60_000)).not.toThrow()
  })

  it('keeps the unauthenticated invitation accept route same-origin and throttled', () => {
    const source = readFileSync(join(ROOT, 'server/api/managed-sites/invitations/accept.post.ts'), 'utf8')
    expect(source).toContain('assertSameOriginManagedSiteMutation(event)')
    expect(source).toContain('enforceManagedSiteAccessRateLimit')
    expect(source).toContain("'Cache-Control', 'private, no-store, max-age=0'")
  })
})
