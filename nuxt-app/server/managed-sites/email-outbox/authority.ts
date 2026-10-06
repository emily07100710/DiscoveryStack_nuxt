import { createHash } from 'node:crypto'
import type { ManagedSiteFunnelSession } from '../../database/schema'
import { getFunnelSessionRepository, type FunnelSessionRepository } from '../funnel/session-repository'
import { getManagedSiteContactInboxBindingRepository, type ManagedSiteContactInboxBindingRepository } from '../contact-inbox/binding-repository'
import { getManagedSiteContactFormRepository, type ManagedSiteContactFormRepository } from '../contact-form/repository'
import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { getManagedSiteLiveConnectorRepository } from '../live-connectors/repository'
import type { ManagedSiteLiveConnectorRepository } from '../live-connectors/types'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { normalizeRecipientEmail, tokenHash } from '../normalization'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { assertManagedSiteProductionPayment } from '../live-connectors/production-payment-authority'
import { resolveManagedSiteReaccessOrigin, MANAGED_SITE_REACCESS_PATH } from '../reaccess-service'
import type { ManagedSiteEmailAuthorityResolver, ManagedSiteEmailOutboxContext, ManagedSiteEmailMessage } from './types'
const CUSTOMER_WORKSPACE_NOTIFICATION_RECEIPT_TYPE = 'customer_workspace_notification_sent'

type AuthorityDependencies = {
  bindingRepository?: ManagedSiteContactInboxBindingRepository
  funnelRepository?: FunnelSessionRepository
  contactRepository?: ManagedSiteContactFormRepository
  managedRepository?: ManagedSiteRepository
  liveRepository?: ManagedSiteLiveConnectorRepository
  orderingRepository?: PreviewRepository
  codePepper?: string
  portalOrigin?: string
  nodeEnv?: string
  clock?: () => Date
}

function nowOf(dependencies: AuthorityDependencies): Date { return (dependencies.clock || (() => new Date()))() }
function asDate(value: Date | string): Date { return value instanceof Date ? value : new Date(value) }
function eqMessage(actual: ManagedSiteEmailMessage, expected: Omit<ManagedSiteEmailMessage, 'idempotencyKey'>): boolean {
  return actual.to === expected.to && actual.subject === expected.subject && actual.text === expected.text && actual.replyTo === expected.replyTo
}
function inboxRepo(dependencies: AuthorityDependencies) { return dependencies.bindingRepository || getManagedSiteContactInboxBindingRepository() }
function funnelRepo(dependencies: AuthorityDependencies) { return dependencies.funnelRepository || getFunnelSessionRepository() }
function contactRepo(dependencies: AuthorityDependencies) { return dependencies.contactRepository || getManagedSiteContactFormRepository() }
function managedRepo(dependencies: AuthorityDependencies) { return dependencies.managedRepository || getManagedSiteRepository() }
function liveRepo(dependencies: AuthorityDependencies) { return dependencies.liveRepository || getManagedSiteLiveConnectorRepository() }
function orderingRepo(dependencies: AuthorityDependencies) { return dependencies.orderingRepository || getPreviewRepository() }

function codeDigest(pepper: string, sessionId: number, code: string): string {
  return createHash('sha256').update(`${pepper}:${sessionId}:${code}`).digest('hex')
}

function validSessionStatus(session: ManagedSiteFunnelSession): boolean {
  return ['active', 'building', 'checkout_pending', 'converted'].includes(session.status)
}

function verificationMessage(code: string) {
  return {
    subject: 'DiscoveryStack 收信信箱驗證碼',
    text: `你的 DiscoveryStack 收信信箱驗證碼是：${code}\n\n此驗證碼將於 10 分鐘後失效。DiscoveryStack 的任何人都不會向你索取這組驗證碼，請勿轉交他人。`,
  }
}

function siteLabel(project: { canonicalWebsiteIdentity: string; canonicalClientIdentity: string; id: number }): string {
  return project.canonicalWebsiteIdentity || project.canonicalClientIdentity || `#${project.id}`
}

function reaccessMessage(links: Array<{ label: string; url: string }>) {
  const lines = links.map(link => `・${link.label}\n  ${link.url}`).join('\n\n')
  const heading = links.length > 1 ? '這是您名下網站的管理連結：' : '這是您的網站管理連結：'
  return {
    subject: '重新進入您的網站管理後台',
    text: ['您好，', '', heading, '', lines, '', '連結 30 分鐘內有效，而且只能使用一次。', '如果這不是您本人要求的，請直接忽略這封信；沒有人會因此進入您的網站，您的網站也不會有任何變動。'].join('\n'),
  }
}

function invitationRoleLabel(role: string): string | null {
  return ({ administrator: '管理員', editor: '編輯者', reviewer: '審稿者', analyst: '分析者' } as Record<string, string>)[role] || null
}

function invitationMessage(input: { label: string; role: string; invitationUrl: string; reaccessUrl: string; expiresAt: Date }) {
  const roleLabel = invitationRoleLabel(input.role)
  if (!roleLabel) return null
  return {
    subject: `您受邀管理 ${input.label} 的網站`,
    text: ['您好，', '', `您已受邀以「${roleLabel}」身分管理 ${input.label} 的 DiscoveryStack 網站。`, `請在 ${input.expiresAt.toISOString()} 前開啟以下一次性連結：`, '', input.invitationUrl, '', '開啟連結只會顯示確認頁；按下「進入網站後台」後，連結才會被使用。', `若連結已失效，請至 ${input.reaccessUrl} 輸入本信箱，重新取得短效登入連結。`, '如果您不認得這項邀請，請直接忽略這封信。'].join('\n'),
  }
}

function contactMessage(input: { client: string; name: string; email: string; phone: string | null; message: string }) {
  return {
    subject: `網站聯絡表單新訊息｜${input.client}`,
    text: `你的網站收到一則新的聯絡表單訊息。\n\n姓名：${input.name}\nEmail：${input.email}\n電話：${input.phone || '未提供'}\n\n訊息：\n${input.message}`,
  }
}

function readyMessage(input: { customerName: string; siteLabel: string; publicUrl: string; reaccessUrl: string }) {
  const greeting = input.customerName ? `${input.customerName} 您好，` : '您好，'
  return {
    subject: '您的網站已經上線',
    text: [greeting, '', `${input.siteLabel} 已完成建立並通過正式上線確認：`, input.publicUrl, '', '要修改文字、圖片或頁面時，請從這裡重新取得安全登入連結：', input.reaccessUrl, '', '為了保護您的帳號，這封信不附登入權杖。進入上方入口後，請輸入本信收件信箱，我們會另外寄出一次性的登入連結。', '', '正式交付後 30 天內，原功能範圍的排版、色彩、字體與圖片安排免費調整。登入網站工作區後，請從「免費美術調整」提交需求並查看進度。新增功能、資料搬遷、新串接及第三方費用另行確認。', '', '如果您沒有購買這個網站，請透過 DiscoveryStack 官方網站的聯絡入口通知我們。'].join('\n'),
  }
}

async function resolveInbox(context: Extract<ManagedSiteEmailOutboxContext, { purpose: 'inbox_verification' }>, message: ManagedSiteEmailMessage, dependencies: AuthorityDependencies) {
  const [session, rows] = await Promise.all([
    funnelRepo(dependencies).findSession(context.authority.funnelSessionId),
    inboxRepo(dependencies).listForSession(context.authority.funnelSessionId),
  ])
  const binding = rows.find(row => row.id === context.authority.bindingId)
  const now = nowOf(dependencies)
  if (!session || !validSessionStatus(session) || session.expiresAt <= now || !binding || binding.funnelSessionId !== session.id || binding.projectId !== context.projectId || binding.status !== 'pending' || binding.codeHash !== context.authority.codeHash || !binding.codeExpiresAt || binding.codeExpiresAt <= now || binding.codeExpiresAt.getTime() !== asDate(context.expiresAt).getTime()) return { current: false }
  const match = /^你的 DiscoveryStack 收信信箱驗證碼是：(\d{6})\n\n此驗證碼將於 10 分鐘後失效。DiscoveryStack 的任何人都不會向你索取這組驗證碼，請勿轉交他人。$/u.exec(message.text)
  if (!match || !dependencies.codePepper || codeDigest(dependencies.codePepper, session.id, match[1]!) !== binding.codeHash || !eqMessage(message, { to: binding.email, ...verificationMessage(match[1]!) })) return { current: false }
  return {
    current: true,
    afterAccept: async () => {
      const latest = (await inboxRepo(dependencies).listForSession(session.id)).find(row => row.id === binding.id)
      if (!latest || latest.status !== 'pending' || latest.codeHash !== binding.codeHash) throw new Error('binding changed after provider acceptance')
      if (latest.lastSentAt) return
      const updated = await inboxRepo(dependencies).updateBinding(binding.id, 'pending', { sendCount: 1, lastSentAt: nowOf(dependencies) })
      if (!updated) throw new Error('binding delivery receipt could not be recorded')
    },
  }
}

function extractToken(urlValue: string, origin: string): string | null {
  try {
    const url = new URL(urlValue)
    if (url.origin !== origin || url.pathname !== MANAGED_SITE_REACCESS_PATH || [...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1 || url.hash) return null
    const token = url.searchParams.get('token')
    return token && /^[A-Za-z0-9_-]{40,64}$/u.test(token) ? token : null
  } catch { return null }
}

async function resolveReaccess(context: Extract<ManagedSiteEmailOutboxContext, { purpose: 'customer_reaccess' }>, message: ManagedSiteEmailMessage, dependencies: AuthorityDependencies) {
  const origin = resolveManagedSiteReaccessOrigin({ portalOrigin: dependencies.portalOrigin, nodeEnv: dependencies.nodeEnv })
  if (!origin || !context.authority.bindings.length || context.authority.bindings.length > 10) return { current: false }
  try { if (message.to !== normalizeRecipientEmail(message.to)) return { current: false } } catch { return { current: false } }
  const projectLinks: Array<{ label: string; url: string }> = []
  const tokens = extractTokens(message.text, origin)
  if (!tokens || tokens.length !== context.authority.bindings.length) return { current: false }
  const now = nowOf(dependencies)
  for (const [index, ref] of context.authority.bindings.entries()) {
    const [project, invitation, membership] = await Promise.all([
      managedRepo(dependencies).findProject(context.ownerUserId, ref.projectId),
      managedRepo(dependencies).findInvitation(context.ownerUserId, ref.invitationId),
      managedRepo(dependencies).findMembership(context.ownerUserId, ref.membershipId),
    ])
    if (!project || project.status !== 'active' || !invitation || invitation.projectId !== project.id || invitation.membershipId !== ref.membershipId || invitation.status !== 'pending' || invitation.expiresAt <= now || invitation.expiresAt.getTime() !== asDate(context.expiresAt).getTime() || invitation.tokenHash !== ref.tokenHash || invitation.recipientEmail !== message.to || !membership || membership.projectId !== project.id || membership.status !== 'active' || membership.role !== invitation.role || membership.principalEmail !== message.to) return { current: false }
    const token = tokens[index]
    if (!token || tokenHash(token) !== invitation.tokenHash) return { current: false }
    projectLinks.push({ label: siteLabel(project), url: `${origin}${MANAGED_SITE_REACCESS_PATH}?token=${encodeURIComponent(token)}` })
  }
  const composed = reaccessMessage(projectLinks)
  return { current: eqMessage(message, { to: message.to, ...composed }) }
}

function extractTokens(text: string, origin: string): string[] | null {
  const lines = text.split('\n')
  const candidates: string[] = []
  for (let index = 0; index < lines.length - 1; index++) {
    if (lines[index]!.startsWith('・')) {
      const token = extractToken(lines[index + 1]!.trim(), origin)
      if (token) candidates.push(token)
    }
  }
  return candidates.length ? candidates : null
}

async function resolveInvitation(context: Extract<ManagedSiteEmailOutboxContext, { purpose: 'member_invitation' }>, message: ManagedSiteEmailMessage, dependencies: AuthorityDependencies) {
  const origin = resolveManagedSiteReaccessOrigin({ portalOrigin: dependencies.portalOrigin, nodeEnv: dependencies.nodeEnv })
  if (!origin) return { current: false }
  const [invitation, project] = await Promise.all([
    managedRepo(dependencies).findInvitation(context.ownerUserId, context.authority.invitationId),
    managedRepo(dependencies).findProject(context.ownerUserId, context.projectId),
  ])
  const now = nowOf(dependencies)
  if (!invitation || invitation.projectId !== context.projectId || invitation.status !== 'pending' || invitation.expiresAt <= now || invitation.expiresAt.getTime() !== asDate(context.expiresAt).getTime() || invitation.tokenHash !== context.authority.tokenHash || invitation.role === 'owner' || !project || project.status !== 'active') return { current: false }
  const membership = await managedRepo(dependencies).findMembership(context.ownerUserId, invitation.membershipId)
  if (!membership || membership.projectId !== project.id || membership.status !== 'active' || membership.role !== invitation.role || membership.principalEmail !== invitation.recipientEmail) return { current: false }
  const token = extractTokenForSingle(message.text, origin)
  if (!token || tokenHash(token) !== invitation.tokenHash) return { current: false }
  const label = project.canonicalClientIdentity || project.canonicalWebsiteIdentity || `網站專案 #${project.id}`
  const composed = invitationMessage({ label, role: invitation.role, invitationUrl: `${origin}${MANAGED_SITE_REACCESS_PATH}?token=${encodeURIComponent(token)}`, reaccessUrl: `${origin}${MANAGED_SITE_REACCESS_PATH}`, expiresAt: invitation.expiresAt })
  return { current: Boolean(composed && eqMessage(message, { to: invitation.recipientEmail, ...composed })) }
}

function extractTokenForSingle(text: string, origin: string): string | null {
  const pathLine = text.split('\n').find(line => line.startsWith(`${origin}${MANAGED_SITE_REACCESS_PATH}?token=`))
  return pathLine ? extractToken(pathLine, origin) : null
}

async function resolveContact(context: Extract<ManagedSiteEmailOutboxContext, { purpose: 'contact_form_forward' }>, message: ManagedSiteEmailMessage, dependencies: AuthorityDependencies) {
  const repository = contactRepo(dependencies)
  const findSubmission = repository.findSubmission
  if (!findSubmission) return { current: false }
  const [submission, project, boundInbox, currentBoundInbox] = await Promise.all([
    findSubmission(context.authority.submissionId),
    managedRepo(dependencies).findProject(context.ownerUserId, context.projectId),
    inboxRepo(dependencies).findBindingById?.(context.authority.bindingId) || Promise.resolve(null),
    contactRepo(dependencies).findBoundInbox(context.projectId),
  ])
  if (!submission || submission.id !== context.authority.submissionId || submission.projectId !== context.projectId || !['received', 'forwarded'].includes(submission.status) || submission.dedupeKey !== context.authority.dedupeKey || !project || project.status !== 'active' || !boundInbox || !currentBoundInbox || currentBoundInbox.id !== boundInbox.id || boundInbox.projectId !== project.id || boundInbox.status !== 'bound') return { current: false }
  const now = nowOf(dependencies)
  if (submission.createdAt.getTime() + 24 * 60 * 60_000 <= now.getTime() || asDate(context.expiresAt).getTime() !== submission.createdAt.getTime() + 24 * 60 * 60_000) return { current: false }
  const expected = contactMessage({ client: project.canonicalClientIdentity, name: submission.submittedName, email: submission.submittedEmail, phone: submission.submittedPhone, message: submission.submittedMessage })
  if (!eqMessage(message, { to: boundInbox.email, replyTo: submission.submittedEmail, ...expected })) return { current: false }
  return {
    current: true,
    afterAccept: async () => {
      const latest = await findSubmission(context.authority.submissionId)
      if (!latest || !['received', 'forwarded'].includes(latest.status) || latest.dedupeKey !== context.authority.dedupeKey || latest.projectId !== context.projectId) throw new Error('contact submission changed after provider acceptance')
      if (latest.status === 'forwarded' && latest.forwardTargetEmail === boundInbox.email && latest.forwardedAt) return
      const changed = await repository.updateSubmission(latest.id, { status: 'forwarded', forwardedAt: nowOf(dependencies), forwardTargetEmail: boundInbox.email, forwardErrorCode: null })
      if (!changed) throw new Error('contact forward receipt could not be recorded')
    },
  }
}

async function resolveWorkspace(context: Extract<ManagedSiteEmailOutboxContext, { purpose: 'workspace_ready' }>, message: ManagedSiteEmailMessage, dependencies: AuthorityDependencies) {
  const live = liveRepo(dependencies), ordering = orderingRepo(dependencies), managed = managedRepo(dependencies)
  const release = await live.findRelease(context.ownerUserId, context.authority.releaseId)
  if (!release || release.projectId !== context.projectId || release.draftOrderId !== context.authority.draftOrderId || release.releaseKind !== 'generated_site' || !['live_verified', 'geo_active'].includes(release.status) || release.activeDeploymentReceiptFingerprint !== context.authority.productionReceiptFingerprint) return { current: false }
  await assertManagedSiteProductionPayment(context.ownerUserId, release, live, ordering, managed)
  const [order, project, receipts, deployment, membership] = await Promise.all([
    ordering.findDraftOrderById(context.authority.draftOrderId),
    managed.findProject(context.ownerUserId, context.projectId),
    live.listReceiptsByDraftOrder(context.ownerUserId, context.authority.draftOrderId),
    live.findReceiptByFingerprint(context.ownerUserId, context.authority.productionReceiptFingerprint),
    managed.findMembership(context.ownerUserId, context.authority.membershipId),
  ])
  if (!order || order.ownerUserId !== context.ownerUserId || order.projectId !== context.projectId || order.status !== 'payment_verified' || !project || project.status === 'suspended' || !deployment || deployment.releaseId !== release.id || deployment.projectId !== context.projectId || deployment.contentHash !== release.contentHash || deployment.canonicalDomain !== release.canonicalDomain || deployment.receiptType !== 'production_deployment_verified' || deployment.receiptStatus !== 'verified' || !membership || membership.projectId !== context.projectId || membership.status !== 'active') return { current: false }
  const payment = receipts.find(row => row.receiptFingerprint === context.authority.paymentReceiptFingerprint && row.releaseId === release.id && row.projectId === context.projectId && row.contentHash === release.contentHash && row.canonicalDomain === release.canonicalDomain && row.receiptType === 'checkout_succeeded' && row.receiptStatus === 'verified' && (row.metadata as Record<string, unknown>)?.effective === true)
  const workspace = receipts.find(row => row.receiptFingerprint === context.authority.workspaceReceiptFingerprint && row.releaseId === release.id && row.projectId === context.projectId && row.contentHash === release.contentHash && row.canonicalDomain === release.canonicalDomain && row.receiptType === 'customer_workspace_bootstrapped' && row.receiptStatus === 'verified' && (row.metadata as Record<string, unknown>)?.productionReceiptFingerprint === context.authority.productionReceiptFingerprint)
  const recipient = normalizeRecipientEmail(membership.principalEmail)
  const lead = await ordering.findLeadById(order.leadId)
  if (!payment || !workspace || !lead || normalizeRecipientEmail(lead.email) !== recipient) return { current: false }
  const recipientFingerprint = stableFingerprint({ recipientEmail: recipient })
  const requestFingerprint = stableFingerprint({ scope: 'managed-site-customer-workspace-notification-v1', ownerUserId: context.ownerUserId, projectId: context.projectId, draftOrderId: order.id, releaseId: release.id, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, paymentReceiptFingerprint: payment.receiptFingerprint, workspaceReceiptFingerprint: workspace.receiptFingerprint, recipientFingerprint, membershipId: membership.id })
  if (requestFingerprint !== context.authority.requestFingerprint) return { current: false }
  const origin = resolveManagedSiteReaccessOrigin({ portalOrigin: dependencies.portalOrigin, nodeEnv: dependencies.nodeEnv })
  if (!origin) return { current: false }
  const expected = readyMessage({ customerName: lead.name.normalize('NFC').trim().slice(0, 160), siteLabel: project.canonicalClientIdentity, publicUrl: `https://${release.canonicalDomain}`, reaccessUrl: `${origin}${MANAGED_SITE_REACCESS_PATH}` })
  if (!eqMessage(message, { to: recipient, ...expected })) return { current: false }
  const receiptFingerprint = stableFingerprint({ requestFingerprint, delivered: true })
  return {
    current: true,
    afterAccept: async (receiptId: string) => {
      const currentReceipts = await live.listReceiptsByDraftOrder(context.ownerUserId, order.id)
      const existing = currentReceipts.find(row => row.receiptType === CUSTOMER_WORKSPACE_NOTIFICATION_RECEIPT_TYPE && row.releaseId === release.id && row.receiptStatus === 'verified')
      if (existing) {
        const metadata = existing.metadata as Record<string, unknown>
        if (existing.requestFingerprint !== requestFingerprint || existing.receiptFingerprint !== receiptFingerprint || metadata.paymentReceiptFingerprint !== payment.receiptFingerprint || metadata.workspaceReceiptFingerprint !== workspace.receiptFingerprint || metadata.recipientFingerprint !== recipientFingerprint || metadata.membershipId !== membership.id) throw new Error('workspace notification receipt collision')
        return
      }
      const saved = await live.insertReceipt({
        ownerUserId: context.ownerUserId, projectId: context.projectId, draftOrderId: order.id, releaseId: release.id, attemptId: null,
        capability: 'deployment', providerKey: 'discoverystack-customer-workspace', providerEventId: `workspace-ready-${receiptFingerprint.slice(0, 32)}`,
        receiptType: CUSTOMER_WORKSPACE_NOTIFICATION_RECEIPT_TYPE, receiptStatus: 'verified', externalReference: `managed-site-project:${context.projectId}`,
        exactResponseIdentity: `workspace-ready:${receiptFingerprint.slice(0, 48)}`, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain,
        metadata: { paymentReceiptFingerprint: payment.receiptFingerprint, workspaceReceiptFingerprint: workspace.receiptFingerprint, recipientFingerprint, membershipId: membership.id, portalPath: MANAGED_SITE_REACCESS_PATH, providerMessageFingerprint: stableFingerprint({ providerMessageId: receiptId }), bearerIncluded: false },
        receiptFingerprint, verifiedAt: nowOf(dependencies),
      } as any)
      if (saved.receiptFingerprint !== receiptFingerprint) throw new Error('workspace notification receipt collided')
    },
  }
}

export function createManagedSiteEmailAuthorityResolver(dependencies: AuthorityDependencies = {}): ManagedSiteEmailAuthorityResolver {
  return async (context, message) => {
    if (context.expiresAt <= nowOf(dependencies)) return { current: false }
    switch (context.purpose) {
      case 'inbox_verification': return await resolveInbox(context, message, dependencies)
      case 'customer_reaccess': return await resolveReaccess(context, message, dependencies)
      case 'member_invitation': return await resolveInvitation(context, message, dependencies)
      case 'contact_form_forward': return await resolveContact(context, message, dependencies)
      case 'workspace_ready': return await resolveWorkspace(context, message, dependencies)
    }
  }
}

export type { AuthorityDependencies as ManagedSiteEmailAuthorityDependencies }
