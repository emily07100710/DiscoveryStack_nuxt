import { describe, expect, it } from 'vitest'
import { createRecordingManagedSiteEmailTransport, type ManagedSiteEmailTransport } from '../server/managed-sites/contact-inbox/email-transport'
import { inviteAndDeliverManagedSiteMember } from '../server/managed-sites/member-invitation-delivery'
import { acceptManagedSiteInvitation, createManagedSiteProject } from '../server/managed-sites/service'
import type { ManagedSiteActor } from '../server/managed-sites/types'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'

const OWNER_USER_ID = 1
const PORTAL_ORIGIN = 'https://private.discoverystack.example'
const CUSTOMER = 'member@example.com'
const ownerActor: ManagedSiteActor = {
  ownerUserId: OWNER_USER_ID,
  actorUserId: OWNER_USER_ID,
  authority: 'owner_session',
  role: 'owner',
  principal: `owner-${OWNER_USER_ID}@internal.invalid`,
}

async function fixture() {
  const managed = createManagedSiteMemoryRepository()
  const created = await createManagedSiteProject(OWNER_USER_ID, ownerActor, {
    canonicalClientIdentity: 'Acme Studio',
    canonicalWebsiteIdentity: 'acme.example',
    siteType: 'one_page',
    idempotencyKey: 'member-delivery-project',
  }, managed.repository)
  return { managed, projectId: created.project.id }
}

function input(idempotencyKey = 'member-delivery-invite') {
  return { email: CUSTOMER, role: 'editor', idempotencyKey }
}

function tokenFrom(text: string): string {
  return decodeURIComponent(text.match(/\/managed-site-access\?token=([A-Za-z0-9_%\-]+)/u)?.[1] || '')
}

describe('managed-site member invitation delivery', () => {
  it('emails the browser confirmation URL and removes the bearer from a successful owner response', async () => {
    const { managed, projectId } = await fixture()
    const transport = createRecordingManagedSiteEmailTransport()

    const result = await inviteAndDeliverManagedSiteMember(OWNER_USER_ID, projectId, ownerActor, input(), {
      repository: managed.repository,
      emailTransport: transport,
      portalOrigin: PORTAL_ORIGIN,
    })

    expect(result).toMatchObject({
      invitationToken: null,
      invitationUrl: null,
      reaccessPath: '/managed-site-access',
      delivery: { status: 'sent' },
    })
    expect(transport.messages).toHaveLength(1)
    expect(transport.messages[0]).toMatchObject({ to: CUSTOMER })
    expect(transport.messages[0]!.subject).toContain('Acme Studio')
    expect(transport.messages[0]!.text).toContain(`${PORTAL_ORIGIN}/managed-site-access?token=`)
    expect(transport.messages[0]!.text).toContain(`${PORTAL_ORIGIN}/managed-site-access`)
    expect(transport.messages[0]!.idempotencyKey).toMatch(/^[a-f0-9]{64}$/u)
    expect(transport.messages[0]!.idempotencyKey).not.toContain(CUSTOMER)

    const token = tokenFrom(transport.messages[0]!.text)
    expect(token).toBeTruthy()
    expect(JSON.stringify(managed.state)).not.toContain(token)
    await expect(acceptManagedSiteInvitation(token, managed.repository)).resolves.toMatchObject({ project: { id: projectId } })
  })

  it('returns the one-time manual URL when mail is not configured', async () => {
    const { managed, projectId } = await fixture()
    const transport: ManagedSiteEmailTransport = {
      configured: false,
      async send() { throw new Error('must not send') },
    }

    const result = await inviteAndDeliverManagedSiteMember(OWNER_USER_ID, projectId, ownerActor, input(), {
      repository: managed.repository,
      emailTransport: transport,
      portalOrigin: PORTAL_ORIGIN,
    })

    expect(result.delivery).toEqual({ status: 'manual_required', missing: 'email_transport' })
    expect(result.invitationToken).toBeTruthy()
    expect(result.invitationUrl).toBe(`${PORTAL_ORIGIN}/managed-site-access?token=${encodeURIComponent(result.invitationToken!)}`)
  })

  it('uses a same-service relative fallback when the canonical private origin is missing', async () => {
    const { managed, projectId } = await fixture()
    const transport = createRecordingManagedSiteEmailTransport()

    const result = await inviteAndDeliverManagedSiteMember(OWNER_USER_ID, projectId, ownerActor, input(), {
      repository: managed.repository,
      emailTransport: transport,
      portalOrigin: '',
    })

    expect(result.delivery).toEqual({ status: 'manual_required', missing: 'portal_origin' })
    expect(result.invitationUrl).toBe(`/managed-site-access?token=${encodeURIComponent(result.invitationToken!)}`)
    expect(transport.messages).toHaveLength(0)
  })

  it('keeps manual recovery available when the provider rejects delivery', async () => {
    const { managed, projectId } = await fixture()
    const transport: ManagedSiteEmailTransport = {
      configured: true,
      async send() { throw new Error('provider unavailable') },
    }

    const result = await inviteAndDeliverManagedSiteMember(OWNER_USER_ID, projectId, ownerActor, input(), {
      repository: managed.repository,
      emailTransport: transport,
      portalOrigin: PORTAL_ORIGIN,
    })

    expect(result.delivery).toEqual({ status: 'delivery_failed' })
    expect(result.invitationToken).toBeTruthy()
    expect(result.invitationUrl).toContain('/managed-site-access?token=')
    await expect(acceptManagedSiteInvitation(result.invitationToken!, managed.repository)).resolves.toMatchObject({ project: { id: projectId } })
  })

  it('does not mint or disclose another token for an existing pending invitation and points to re-access recovery', async () => {
    const { managed, projectId } = await fixture()
    const firstTransport = createRecordingManagedSiteEmailTransport()
    await inviteAndDeliverManagedSiteMember(OWNER_USER_ID, projectId, ownerActor, input('member-delivery-first'), {
      repository: managed.repository,
      emailTransport: firstTransport,
      portalOrigin: PORTAL_ORIGIN,
    })
    const replayTransport = createRecordingManagedSiteEmailTransport()

    const replay = await inviteAndDeliverManagedSiteMember(OWNER_USER_ID, projectId, ownerActor, input('member-delivery-second'), {
      repository: managed.repository,
      emailTransport: replayTransport,
      portalOrigin: PORTAL_ORIGIN,
    })

    expect(replay).toMatchObject({ replayed: true, invitationToken: null, invitationUrl: null, reaccessPath: '/managed-site-access', delivery: { status: 'already_pending' } })
    expect(replayTransport.messages).toHaveLength(0)
    expect(managed.state.invitations).toHaveLength(1)
  })
})
