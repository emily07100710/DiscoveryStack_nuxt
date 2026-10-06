import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createManagedSiteEmailAuthorityResolver } from '../server/managed-sites/email-outbox/authority'
import { tokenHash } from '../server/managed-sites/normalization'

const NOW = new Date('2034-02-03T04:05:06.000Z')
const PORTAL = 'https://portal.example.test'
const PEPPER = 'authority-test-pepper-with-more-than-32-bytes'
const EMAIL = 'member@example.com'
const codeHash = (sessionId: number, code: string) => createHash('sha256').update(`${PEPPER}:${sessionId}:${code}`).digest('hex')

describe('managed-site email outbox production authority', () => {
  it('binds a pre-purchase verification message to the exact pending binding and persisted challenge', async () => {
    const expectedHash = codeHash(42, '123456')
    const binding: any = { id: 8, funnelSessionId: 42, projectId: null, email: EMAIL, status: 'pending', codeHash: expectedHash, codeExpiresAt: new Date(NOW.getTime() + 600_000), createdAt: NOW, lastSentAt: null, sendCount: 0 }
    const dependencies: any = {
      clock: () => NOW,
      codePepper: PEPPER,
      funnelRepository: { async findSession() { return { id: 42, projectId: null, status: 'active', expiresAt: new Date(NOW.getTime() + 86_400_000) } } },
      bindingRepository: { async listForSession() { return [binding] }, async updateBinding(_id: number, _status: string, patch: any) { Object.assign(binding, patch); return binding } },
    }
    const resolve = createManagedSiteEmailAuthorityResolver(dependencies)
    const context = { purpose: 'inbox_verification' as const, ownerUserId: null, projectId: null, authority: { funnelSessionId: 42, bindingId: 8, codeHash: expectedHash }, expiresAt: binding.codeExpiresAt }
    const message = { to: EMAIL, subject: 'DiscoveryStack 收信信箱驗證碼', text: '你的 DiscoveryStack 收信信箱驗證碼是：123456\n\n此驗證碼將於 10 分鐘後失效。DiscoveryStack 的任何人都不會向你索取這組驗證碼，請勿轉交他人。', idempotencyKey: 'verification:42' }

    const authorized = await resolve(context, message)
    expect(authorized.current).toBe(true)
    await authorized.afterAccept?.('provider-receipt')
    expect(binding).toMatchObject({ lastSentAt: NOW, sendCount: 1 })
    binding.status = 'superseded'
    expect((await resolve(context, message)).current).toBe(false)
  })

  it('reconstructs every re-access link from active project, membership, invitation, and token-hash rows', async () => {
    const expiresAt = new Date(NOW.getTime() + 1_800_000)
    const tokens = ['first-token-value-123456789012345678901234', 'second-token-value-123456789012345678901234']
    const projects = [
      { id: 3, ownerUserId: 7, status: 'active', canonicalWebsiteIdentity: 'first.example', canonicalClientIdentity: 'First' },
      { id: 4, ownerUserId: 7, status: 'active', canonicalWebsiteIdentity: 'second.example', canonicalClientIdentity: 'Second' },
    ]
    const refs = projects.map((project, index) => ({ projectId: project.id, invitationId: 10 + index, membershipId: 20 + index, tokenHash: tokenHash(tokens[index]!) }))
    const resolve = createManagedSiteEmailAuthorityResolver({
      portalOrigin: PORTAL,
      nodeEnv: 'production',
      clock: () => NOW,
      managedRepository: {
        async findProject(_owner: number, id: number) { return projects.find(project => project.id === id) || null },
        async findInvitation(_owner: number, id: number) { const index = id - 10; return { ...refs[index], id, ownerUserId: 7, projectId: refs[index]?.projectId, membershipId: refs[index]?.membershipId, tokenHash: refs[index]?.tokenHash, recipientEmail: EMAIL, role: 'editor', status: 'pending', expiresAt } },
        async findMembership(_owner: number, id: number) { const index = id - 20; return { id, ownerUserId: 7, projectId: projects[index]?.id, principalEmail: EMAIL, role: 'editor', status: 'active' } },
      } as any,
    })
    const context = { purpose: 'customer_reaccess' as const, ownerUserId: 7, projectId: null, authority: { bindings: refs }, expiresAt }
    const text = ['您好，', '', '這是您名下網站的管理連結：', '', `・first.example\n  ${PORTAL}/managed-site-access?token=${tokens[0]}`, '', `・second.example\n  ${PORTAL}/managed-site-access?token=${tokens[1]}`, '', '連結 30 分鐘內有效，而且只能使用一次。', '如果這不是您本人要求的，請直接忽略這封信；沒有人會因此進入您的網站，您的網站也不會有任何變動。'].join('\n')
    const message = { to: EMAIL, subject: '重新進入您的網站管理後台', text, idempotencyKey: 'reaccess:ten' }
    expect((await resolve(context, message)).current).toBe(true)
    projects[1]!.status = 'suspended'
    expect((await resolve(context, message)).current).toBe(false)
  })

  it('rejects changed invite authority and lets repository failures retry instead of cancelling', async () => {
    const expiresAt = new Date(NOW.getTime() + 600_000)
    const token = 'member-invitation-token-12345678901234567890'
    const invitation: any = { id: 8, ownerUserId: 7, projectId: 3, membershipId: 11, recipientEmail: EMAIL, role: 'editor', tokenHash: tokenHash(token), status: 'pending', expiresAt }
    const project: any = { id: 3, ownerUserId: 7, status: 'active', canonicalClientIdentity: 'Acme', canonicalWebsiteIdentity: 'acme.example' }
    const membership: any = { id: 11, ownerUserId: 7, projectId: 3, principalEmail: EMAIL, role: 'editor', status: 'active' }
    const managedRepository: any = { async findInvitation() { return invitation }, async findProject() { return project }, async findMembership() { return membership } }
    const resolve = createManagedSiteEmailAuthorityResolver({ managedRepository, portalOrigin: PORTAL, nodeEnv: 'production', clock: () => NOW })
    const context = { purpose: 'member_invitation' as const, ownerUserId: 7, projectId: 3, authority: { invitationId: 8, tokenHash: invitation.tokenHash }, expiresAt }
    const text = ['您好，', '', '您已受邀以「編輯者」身分管理 Acme 的 DiscoveryStack 網站。', `請在 ${expiresAt.toISOString()} 前開啟以下一次性連結：`, '', `${PORTAL}/managed-site-access?token=${token}`, '', '開啟連結只會顯示確認頁；按下「進入網站後台」後，連結才會被使用。', `若連結已失效，請至 ${PORTAL}/managed-site-access 輸入本信箱，重新取得短效登入連結。`, '如果您不認得這項邀請，請直接忽略這封信。'].join('\n')
    const message = { to: EMAIL, subject: '您受邀管理 Acme 的網站', text, idempotencyKey: 'invitation:8' }
    expect((await resolve(context, message)).current).toBe(true)
    membership.status = 'revoked'
    expect((await resolve(context, message)).current).toBe(false)

    const unavailable = createManagedSiteEmailAuthorityResolver({ managedRepository: { async findInvitation() { throw new Error('storage unavailable') }, async findProject() { throw new Error('storage unavailable') } } as any, portalOrigin: PORTAL, nodeEnv: 'production', clock: () => NOW })
    await expect(unavailable(context, message)).rejects.toThrow('storage unavailable')
  })

  it('reconciles contact forwarding idempotently after acceptance and callback restart', async () => {
    const createdAt = new Date(NOW.getTime() - 60_000)
    const binding: any = { id: 9, projectId: 3, email: 'inbox@example.com', status: 'bound' }
    const project: any = { id: 3, ownerUserId: 7, status: 'active', canonicalClientIdentity: 'Acme' }
    const submission: any = { id: 10, projectId: 3, submittedName: 'Visitor', submittedEmail: 'visitor@example.com', submittedPhone: null, submittedMessage: 'Hello there', status: 'received', dedupeKey: 'd'.repeat(64), createdAt }
    const repository: any = {
      async findSubmission() { return submission },
      async findBoundInbox() { return binding },
      async updateSubmission(_id: number, patch: any) { Object.assign(submission, patch); return submission },
    }
    const resolve = createManagedSiteEmailAuthorityResolver({
      contactRepository: repository,
      bindingRepository: { async findBindingById() { return binding } } as any,
      managedRepository: { async findProject() { return project } } as any,
      clock: () => NOW,
    })
    const context = { purpose: 'contact_form_forward' as const, ownerUserId: 7, projectId: 3, authority: { submissionId: 10, bindingId: 9, dedupeKey: submission.dedupeKey }, expiresAt: new Date(createdAt.getTime() + 86_400_000) }
    const message = { to: binding.email, replyTo: submission.submittedEmail, subject: '網站聯絡表單新訊息｜Acme', text: '你的網站收到一則新的聯絡表單訊息。\n\n姓名：Visitor\nEmail：visitor@example.com\n電話：未提供\n\n訊息：\nHello there', idempotencyKey: 'contact:10' }
    const first = await resolve(context, message)
    expect(first.current).toBe(true)
    await first.afterAccept?.('provider-receipt')
    const replay = await resolve(context, message)
    expect(replay.current).toBe(true)
    await replay.afterAccept?.('provider-receipt')
    expect(submission).toMatchObject({ status: 'forwarded', forwardTargetEmail: binding.email })
  })

  it('binds customer-workspace notices to a live paid authority before acceptance', async () => {
    const context = { purpose: 'workspace_ready' as const, ownerUserId: 7, projectId: 3, authority: { releaseId: 4, draftOrderId: 5, membershipId: 6, paymentReceiptFingerprint: 'a'.repeat(64), workspaceReceiptFingerprint: 'b'.repeat(64), productionReceiptFingerprint: 'c'.repeat(64), requestFingerprint: 'd'.repeat(64) }, expiresAt: new Date(NOW.getTime() + 86_400_000) }
    const resolve = createManagedSiteEmailAuthorityResolver({ liveRepository: { async findRelease() { return { id: 4, projectId: 3, draftOrderId: 5, releaseKind: 'generated_site', status: 'suspended', activeDeploymentReceiptFingerprint: context.authority.productionReceiptFingerprint } } } as any, orderingRepository: {} as any, managedRepository: {} as any, clock: () => NOW })
    expect((await resolve(context, { to: EMAIL, subject: 'ready', text: 'payload', idempotencyKey: 'workspace:4' })).current).toBe(false)
  })
})
