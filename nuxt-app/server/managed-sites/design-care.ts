import { createError } from 'h3'
import type { ManagedSiteAuditEvent, ManagedSiteConnectorReceipt, ManagedSiteMembership } from '../database/schema'
import { stableFingerprint } from '../seo-geo-core/repository'
import { DESIGN_CARE_POLICY } from './customer-runtime'
import { getManagedSiteLiveConnectorRepository } from './live-connectors/repository'
import type { ManagedSiteLiveConnectorRepository } from './live-connectors/types'
import { getManagedSiteRepository } from './repository'
import { roleAllows, type ManagedSiteRepository } from './types'

export const MANAGED_SITE_DESIGN_CARE_DAYS = DESIGN_CARE_POLICY.days
export const MANAGED_SITE_DESIGN_CARE_CATEGORIES = DESIGN_CARE_POLICY.included
export const MANAGED_SITE_DESIGN_CARE_STATES = ['submitted', 'reviewing', 'accepted', 'in_progress', 'completed', 'declined'] as const

type DesignCareCategory = typeof MANAGED_SITE_DESIGN_CARE_CATEGORIES[number]
type DesignCareState = typeof MANAGED_SITE_DESIGN_CARE_STATES[number]
type DesignCareViewer = { kind: 'owner' } | { kind: 'customer'; membershipId: number }

export type ManagedSiteDesignCareDependencies = {
  managedRepository?: ManagedSiteRepository
  liveRepository?: ManagedSiteLiveConnectorRepository
  clock?: () => Date
}

export type ManagedSiteDesignCareWindow = {
  status: 'not_started' | 'active' | 'expired'
  startsAt: string | null
  expiresAt: string | null
  remainingDays: number
  canSubmit: boolean
  reason: 'verified_delivery_not_found' | 'verified_delivery_in_future' | 'within_30_day_window' | '30_day_window_expired' | 'role_not_allowed' | 'project_suspended'
  releaseId: number | null
  canonicalDomain: string | null
}

export type ManagedSiteDesignCareRequestProjection = {
  id: number
  category: DesignCareCategory
  description: string
  pageReference: string | null
  state: DesignCareState
  ownerReason: string | null
  submittedAt: string
  updatedAt: string
  submittedByMembershipId?: number
}

export type ManagedSiteDesignCareProjection = {
  schemaVersion: 'managed-site-design-care-v1'
  project: { id: number; label: string }
  window: ManagedSiteDesignCareWindow
  allowedCategories: Array<{ key: DesignCareCategory; label: string }>
  requests: ManagedSiteDesignCareRequestProjection[]
  boundaries: {
    included: readonly string[]
    excluded: readonly string[]
    startsOnlyAfterVerifiedDelivery: true
    redeployDoesNotResetWindow: true
  }
}

const REQUEST_ACTION = 'managed_site_design_care_requested'
const STATE_ACTION = 'managed_site_design_care_state_changed'
const REQUEST_SCHEMA = 'managed-site-design-care-request-v1'
const STATE_SCHEMA = 'managed-site-design-care-state-v1'
const DAY_MS = 24 * 60 * 60 * 1000
const HASH = /^[a-f0-9]{64}$/u
const CATEGORY_LABELS: Record<DesignCareCategory, string> = {
  layout: '版面與間距',
  color: '色彩調整',
  typography: '字體與文字樣式',
  image_placement: '圖片安排',
}
const TRANSITIONS: Record<DesignCareState, readonly DesignCareState[]> = {
  submitted: ['reviewing', 'accepted', 'in_progress', 'completed', 'declined'],
  reviewing: ['accepted', 'in_progress', 'completed', 'declined'],
  accepted: ['in_progress', 'completed', 'declined'],
  in_progress: ['completed', 'declined'],
  completed: [],
  declined: [],
}
// This is deliberately a narrow guard for explicit build/integration/migration work, not a
// semantic scope judge. Names such as "購物車" and "checkout" can identify an existing page
// whose colour or typography is valid design care. The owner still reviews whether each submitted
// request changes only the already-delivered feature set before accepting it.
const CLEARLY_OUT_OF_SCOPE = [
  /(?:新增|新建|建立|開發|增設|加上|加入).{0,24}(?:功能|系統|模組|流程|頁面|後台|資料庫)/iu,
  /(?:重做|重建).{0,24}(?:功能|系統|模組|流程|後台|資料庫)/iu,
  /(?:串接|整合|接入|導入).{0,24}(?:第三方|API|金流|付款|支付|會員|購物車|結帳|預約|資料庫|系統|服務|平台)/iu,
  /(?:第三方|API|金流|付款|支付|會員|購物車|結帳|預約|資料庫|系統|服務|平台).{0,24}(?:串接|整合|接入)/iu,
  /(?:搬遷|移轉|遷移|匯入|轉移).{0,24}(?:資料|資料庫|會員|訂單|商品|客戶|內容)/iu,
  /(?:資料|資料庫|會員|訂單|商品|客戶|內容).{0,24}(?:搬遷|移轉|遷移|匯入|轉移)/iu,
  /\b(?:new|add|build|create|develop)\b.{0,32}\b(?:feature|function(?:ality)?|module|system|workflow|page|admin|database)\b/iu,
  /\b(?:rebuild|replace)\b.{0,32}\b(?:feature|function(?:ality)?|module|system|workflow|backend|database)\b/iu,
  /\b(?:integrat(?:e|ion)|connect)\b.{0,32}\b(?:api|payment|gateway|stripe|shopify|crm|database|booking|checkout|cart|system|service|platform)\b/iu,
  /\b(?:api|payment|gateway|stripe|shopify|crm|database|booking|checkout|cart|system|service|platform)\b.{0,32}\b(?:integration|connection)\b/iu,
  /\b(?:data|database|customer|member|order|product|content)\b.{0,32}\b(?:migration|migrate|import|transfer)\b/iu,
  /\b(?:migrat(?:e|ion)|import|transfer)\b.{0,32}\b(?:data|database|customer|member|order|product|content)\b/iu,
] as const

function isClearlyOutOfScope(description: string): boolean {
  return CLEARLY_OUT_OF_SCOPE.some(pattern => pattern.test(description))
}

function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message })
}

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function notFound(message = 'Managed site design-care request was not found.'): never {
  throw createError({ statusCode: 404, statusMessage: message })
}

function positiveId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(`${label}格式不正確。`)
  return Number(value)
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') invalid(`${label}格式不正確。`)
  const normalized = value.normalize('NFC').trim()
  if (!normalized || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) invalid(`${label}不可空白或超過 ${max} 字。`)
  return normalized
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return boundedText(value, label, max)
}

function idempotencyKey(value: unknown): string {
  const key = boundedText(value, '冪等識別', 128)
  if (key.length < 8 || !/^[a-zA-Z0-9._:-]+$/u.test(key)) invalid('冪等識別格式不正確。')
  return key
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value || ''))
  return Number.isFinite(date.getTime()) ? date : null
}

function exactReceipt(receipt: ManagedSiteConnectorReceipt, input: {
  ownerUserId: number
  projectId: number
  releaseId: number
  draftOrderId: number
  contentHash: string
  canonicalDomain: string
  receiptType: string
}) {
  return receipt.ownerUserId === input.ownerUserId
    && receipt.projectId === input.projectId
    && receipt.releaseId === input.releaseId
    && receipt.draftOrderId === input.draftOrderId
    && receipt.contentHash === input.contentHash
    && receipt.canonicalDomain === input.canonicalDomain
    && receipt.receiptType === input.receiptType
    && receipt.receiptStatus === 'verified'
}

type DeliveryAuthority = {
  deliveredAt: Date
  expiresAt: Date
  releaseId: number
  canonicalDomain: string
  authorityFingerprint: string
  notificationReceiptFingerprint: string
}

async function resolveVerifiedDelivery(
  ownerUserId: number,
  projectId: number,
  managedRepository: ManagedSiteRepository,
  liveRepository: ManagedSiteLiveConnectorRepository,
): Promise<DeliveryAuthority | null> {
  const receipts = await liveRepository.listReceipts(ownerUserId, projectId)
  const notifications = receipts
    .filter(receipt => receipt.ownerUserId === ownerUserId
      && receipt.projectId === projectId
      && receipt.receiptType === 'customer_workspace_notification_sent'
      && receipt.receiptStatus === 'verified'
      && receipt.externalReference === `managed-site-project:${projectId}`)
    .sort((left, right) => (asDate(left.verifiedAt)?.getTime() || Number.MAX_SAFE_INTEGER) - (asDate(right.verifiedAt)?.getTime() || Number.MAX_SAFE_INTEGER) || left.id - right.id)

  for (const notification of notifications) {
    if (!notification.releaseId || !notification.draftOrderId || !notification.contentHash || !notification.canonicalDomain || !HASH.test(notification.receiptFingerprint)) continue
    const release = await liveRepository.findRelease(ownerUserId, notification.releaseId)
    if (!release || release.ownerUserId !== ownerUserId || release.projectId !== projectId || release.releaseKind !== 'generated_site'
      || release.draftOrderId !== notification.draftOrderId || release.contentHash !== notification.contentHash
      || release.canonicalDomain !== notification.canonicalDomain) continue

    const notificationMetadata = record(notification.metadata)
    const paymentFingerprint = notificationMetadata.paymentReceiptFingerprint
    const workspaceFingerprint = notificationMetadata.workspaceReceiptFingerprint
    const deliveryMembershipId = notificationMetadata.membershipId
    if (typeof paymentFingerprint !== 'string' || !HASH.test(paymentFingerprint)
      || typeof workspaceFingerprint !== 'string' || !HASH.test(workspaceFingerprint)
      || !Number.isSafeInteger(deliveryMembershipId) || Number(deliveryMembershipId) < 1) continue

    const deliveryMembership = await managedRepository.findMembership(ownerUserId, Number(deliveryMembershipId))
    if (!deliveryMembership || deliveryMembership.projectId !== projectId) continue
    const exact = {
      ownerUserId,
      projectId,
      releaseId: release.id,
      draftOrderId: notification.draftOrderId,
      contentHash: notification.contentHash,
      canonicalDomain: notification.canonicalDomain,
    }
    const payment = receipts.find(receipt => receipt.receiptFingerprint === paymentFingerprint && exactReceipt(receipt, { ...exact, receiptType: 'checkout_succeeded' }) && record(receipt.metadata).effective === true)
    const bound = receipts.find(receipt => exactReceipt(receipt, { ...exact, receiptType: 'release_payment_bound' })
      && [record(receipt.metadata).paymentReceiptFingerprint, record(receipt.metadata).checkoutReceiptFingerprint].includes(paymentFingerprint))
    const workspace = receipts.find(receipt => receipt.receiptFingerprint === workspaceFingerprint && exactReceipt(receipt, { ...exact, receiptType: 'customer_workspace_bootstrapped' }))
    const productionFingerprint = workspace ? record(workspace.metadata).productionReceiptFingerprint : null
    const production = typeof productionFingerprint === 'string' && HASH.test(productionFingerprint)
      ? receipts.find(receipt => receipt.receiptFingerprint === productionFingerprint && exactReceipt(receipt, { ...exact, receiptType: 'production_deployment_verified' }))
      : null
    const paymentReversed = receipts.some(receipt => receipt.ownerUserId === ownerUserId
      && receipt.projectId === projectId
      && receipt.draftOrderId === notification.draftOrderId
      && receipt.releaseId === release.id
      && receipt.receiptStatus === 'verified'
      && ['payment_refunded', 'payment_disputed'].includes(receipt.receiptType)
      && record(receipt.metadata).effective === true)
    const deliveredAt = asDate(notification.verifiedAt)
    if (!payment || !bound || !workspace || !production || paymentReversed || !deliveredAt) continue

    const authorityFingerprint = stableFingerprint({
      scope: 'managed-site-design-care-delivery-v1',
      ownerUserId,
      projectId,
      releaseId: release.id,
      draftOrderId: notification.draftOrderId,
      contentHash: notification.contentHash,
      canonicalDomain: notification.canonicalDomain,
      paymentReceiptFingerprint: payment.receiptFingerprint,
      boundReceiptFingerprint: bound.receiptFingerprint,
      workspaceReceiptFingerprint: workspace.receiptFingerprint,
      productionReceiptFingerprint: production.receiptFingerprint,
      notificationReceiptFingerprint: notification.receiptFingerprint,
      deliveredAt: deliveredAt.toISOString(),
    })
    return {
      deliveredAt,
      expiresAt: new Date(deliveredAt.getTime() + MANAGED_SITE_DESIGN_CARE_DAYS * DAY_MS),
      releaseId: release.id,
      canonicalDomain: release.canonicalDomain,
      authorityFingerprint,
      notificationReceiptFingerprint: notification.receiptFingerprint,
    }
  }
  return null
}

function currentState(request: ManagedSiteAuditEvent, events: ManagedSiteAuditEvent[]) {
  const changes = events
    .filter(event => event.action === STATE_ACTION && record(event.metadata).schemaVersion === STATE_SCHEMA && record(event.metadata).requestEventId === request.id)
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id - right.id)
  const latest = changes.at(-1)
  const metadata = record(latest?.metadata)
  const state = typeof metadata.state === 'string' && (MANAGED_SITE_DESIGN_CARE_STATES as readonly string[]).includes(metadata.state) ? metadata.state as DesignCareState : 'submitted'
  return { state, reason: typeof metadata.reason === 'string' ? metadata.reason : null, updatedAt: latest?.occurredAt || request.occurredAt }
}

function projectRequests(events: ManagedSiteAuditEvent[], viewer: DesignCareViewer): ManagedSiteDesignCareRequestProjection[] {
  return events
    .filter(event => {
      if (event.action !== REQUEST_ACTION) return false
      const metadata = record(event.metadata)
      if (metadata.schemaVersion !== REQUEST_SCHEMA) return false
      return viewer.kind === 'owner' || metadata.membershipId === viewer.membershipId
    })
    .map(event => {
      const metadata = record(event.metadata)
      const category = metadata.category as DesignCareCategory
      if (!(MANAGED_SITE_DESIGN_CARE_CATEGORIES as readonly unknown[]).includes(category)
        || typeof metadata.description !== 'string'
        || !(metadata.pageReference === null || typeof metadata.pageReference === 'string')) return null
      const state = currentState(event, events)
      return {
        id: event.id,
        category,
        description: metadata.description,
        pageReference: metadata.pageReference as string | null,
        state: state.state,
        ownerReason: state.reason,
        submittedAt: event.occurredAt.toISOString(),
        updatedAt: state.updatedAt.toISOString(),
        ...(viewer.kind === 'owner' && Number.isSafeInteger(metadata.membershipId) ? { submittedByMembershipId: Number(metadata.membershipId) } : {}),
      }
    })
    .filter((request): request is ManagedSiteDesignCareRequestProjection => Boolean(request))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt) || right.id - left.id)
}

function careWindow(delivery: DeliveryAuthority | null, now: Date, roleCanSubmit: boolean, suspended: boolean): ManagedSiteDesignCareWindow {
  if (!delivery) return { status: 'not_started', startsAt: null, expiresAt: null, remainingDays: 0, canSubmit: false, reason: 'verified_delivery_not_found', releaseId: null, canonicalDomain: null }
  const base = { startsAt: delivery.deliveredAt.toISOString(), expiresAt: delivery.expiresAt.toISOString(), releaseId: delivery.releaseId, canonicalDomain: delivery.canonicalDomain }
  if (now.getTime() < delivery.deliveredAt.getTime()) return { ...base, status: 'not_started', remainingDays: MANAGED_SITE_DESIGN_CARE_DAYS, canSubmit: false, reason: 'verified_delivery_in_future' }
  if (now.getTime() >= delivery.expiresAt.getTime()) return { ...base, status: 'expired', remainingDays: 0, canSubmit: false, reason: '30_day_window_expired' }
  const remainingDays = Math.ceil((delivery.expiresAt.getTime() - now.getTime()) / DAY_MS)
  if (suspended) return { ...base, status: 'active', remainingDays, canSubmit: false, reason: 'project_suspended' }
  if (!roleCanSubmit) return { ...base, status: 'active', remainingDays, canSubmit: false, reason: 'role_not_allowed' }
  return { ...base, status: 'active', remainingDays, canSubmit: true, reason: 'within_30_day_window' }
}

async function resolveContext(ownerUserId: number, projectId: number, viewer: DesignCareViewer, dependencies: ManagedSiteDesignCareDependencies) {
  positiveId(ownerUserId, '擁有人識別')
  positiveId(projectId, '專案識別')
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const liveRepository = dependencies.liveRepository || getManagedSiteLiveConnectorRepository()
  const now = new Date((dependencies.clock || (() => new Date()))())
  if (!Number.isFinite(now.getTime())) invalid('伺服器時間設定不正確。')
  const project = await managedRepository.findProject(ownerUserId, projectId)
  if (!project) notFound('Managed site project was not found.')
  let membership: ManagedSiteMembership | null = null
  if (viewer.kind === 'customer') {
    membership = await managedRepository.findMembership(ownerUserId, positiveId(viewer.membershipId, '會員識別'))
    if (!membership || membership.projectId !== projectId || membership.status !== 'active') notFound('Managed site project was not found.')
  }
  const [delivery, events] = await Promise.all([
    resolveVerifiedDelivery(ownerUserId, projectId, managedRepository, liveRepository),
    managedRepository.listAuditEvents(ownerUserId, projectId),
  ])
  const roleCanSubmit = Boolean(membership && roleAllows(membership.role, 'content:write'))
  return { managedRepository, liveRepository, now, project, membership, delivery, events, window: careWindow(delivery, now, roleCanSubmit, project.status === 'suspended') }
}

export async function getManagedSiteDesignCare(
  ownerUserId: number,
  projectId: number,
  viewer: DesignCareViewer,
  dependencies: ManagedSiteDesignCareDependencies = {},
): Promise<ManagedSiteDesignCareProjection> {
  const context = await resolveContext(ownerUserId, projectId, viewer, dependencies)
  return {
    schemaVersion: 'managed-site-design-care-v1',
    project: { id: context.project.id, label: context.project.canonicalClientIdentity },
    window: context.window,
    allowedCategories: MANAGED_SITE_DESIGN_CARE_CATEGORIES.map(key => ({ key, label: CATEGORY_LABELS[key] })),
    requests: projectRequests(context.events, viewer),
    boundaries: {
      included: DESIGN_CARE_POLICY.included.map(key => CATEGORY_LABELS[key]),
      excluded: DESIGN_CARE_POLICY.excluded.map(key => ({ new_features: '新增功能、頁面或模組', data_migration: '資料搬遷', new_integrations: '第三方服務與 API 串接', third_party_fees: '第三方費用' })[key]),
      startsOnlyAfterVerifiedDelivery: true,
      redeployDoesNotResetWindow: true,
    },
  }
}

function parseRequest(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) invalid('設計調整需求格式不正確。')
  const object = input as Record<string, unknown>
  const allowed = ['category', 'description', 'pageReference', 'scopeAcknowledged', 'idempotencyKey']
  if (Object.keys(object).some(key => !allowed.includes(key))) invalid('設計調整需求包含不支援的欄位。')
  if (typeof object.category !== 'string' || !(MANAGED_SITE_DESIGN_CARE_CATEGORIES as readonly string[]).includes(object.category)) invalid('設計調整類別不在 30 天服務範圍內。')
  const description = boundedText(object.description, '調整說明', 2000)
  if (isClearlyOutOfScope(description)) invalid('30 天服務只包含既有版面、色彩、字體與圖片安排；新增功能請另行評估。')
  if (object.scopeAcknowledged !== true) invalid('請先確認本次需求不包含新增功能。')
  return {
    category: object.category as DesignCareCategory,
    description,
    pageReference: optionalText(object.pageReference, '頁面位置', 240),
    idempotencyKey: idempotencyKey(object.idempotencyKey),
  }
}

export async function requestManagedSiteDesignCare(
  ownerUserId: number,
  projectId: number,
  membershipId: number,
  input: unknown,
  dependencies: ManagedSiteDesignCareDependencies = {},
) {
  const parsed = parseRequest(input)
  const viewer: DesignCareViewer = { kind: 'customer', membershipId }
  const context = await resolveContext(ownerUserId, projectId, viewer, dependencies)
  if (!context.membership || !roleAllows(context.membership.role, 'content:write')) throw createError({ statusCode: 403, statusMessage: 'This customer role cannot request design-care changes.' })
  const delivery = context.delivery
  if (!delivery || !context.window.canSubmit) {
    if (context.window.status === 'expired') conflict('30 天設計調整期間已到期。')
    if (context.window.reason === 'project_suspended') conflict('網站專案目前已暫停，不能新增設計調整需求。')
    conflict('30 天設計調整尚未由正式交付收據啟動。')
  }
  const requestFingerprint = stableFingerprint({
    scope: 'managed-site-design-care-request-content-v1',
    ownerUserId,
    projectId,
    membershipId,
    category: parsed.category,
    description: parsed.description,
    pageReference: parsed.pageReference,
    deliveryAuthorityFingerprint: delivery.authorityFingerprint,
  })
  const auditFingerprint = stableFingerprint({
    scope: 'managed-site-design-care-request-idempotency-v1',
    ownerUserId,
    projectId,
    membershipId,
    idempotencyKey: parsed.idempotencyKey,
  })
  const occurredAt = context.now
  const result = await context.managedRepository.transaction(async repository => {
    const currentProject = await repository.findProject(ownerUserId, projectId)
    const currentMembership = await repository.findMembership(ownerUserId, membershipId)
    if (!currentProject || currentProject.status === 'suspended' || !currentMembership || currentMembership.projectId !== projectId || currentMembership.status !== 'active') notFound('Managed site project was not found.')
    const existing = await repository.findAuditEventByFingerprint(ownerUserId, auditFingerprint)
    if (existing) {
      if (existing.projectId !== projectId || existing.action !== REQUEST_ACTION || existing.afterFingerprint !== requestFingerprint) conflict('相同冪等識別已用於不同的設計調整需求。')
      return { event: existing, replayed: true }
    }
    const event = await repository.insertAuditEvent({
      ownerUserId,
      projectId,
      actorUserId: currentMembership.userId,
      authority: 'customer_session',
      action: REQUEST_ACTION,
      beforeFingerprint: delivery.authorityFingerprint,
      afterFingerprint: requestFingerprint,
      eventFingerprint: auditFingerprint,
      metadata: {
        schemaVersion: REQUEST_SCHEMA,
        membershipId,
        category: parsed.category,
        description: parsed.description,
        pageReference: parsed.pageReference,
        scope: 'design_only',
        newFeaturesIncluded: false,
        deliveryAuthorityFingerprint: delivery.authorityFingerprint,
        notificationReceiptFingerprint: delivery.notificationReceiptFingerprint,
        careStartsAt: delivery.deliveredAt.toISOString(),
        careExpiresAt: delivery.expiresAt.toISOString(),
      },
      occurredAt,
    })
    if (event.projectId !== projectId || event.action !== REQUEST_ACTION || event.afterFingerprint !== requestFingerprint) conflict('相同冪等識別已用於不同的設計調整需求。')
    return { event, replayed: false }
  })
  const projection = await getManagedSiteDesignCare(ownerUserId, projectId, viewer, dependencies)
  const request = projection.requests.find(item => item.id === result.event.id)
  if (!request) conflict('設計調整需求已記錄，但無法建立安全投影。')
  return { care: projection, request, replayed: result.replayed }
}

function parseStateChange(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) invalid('設計調整狀態格式不正確。')
  const object = input as Record<string, unknown>
  const allowed = ['requestId', 'state', 'reason', 'idempotencyKey']
  if (Object.keys(object).some(key => !allowed.includes(key))) invalid('設計調整狀態包含不支援的欄位。')
  if (typeof object.state !== 'string' || !(MANAGED_SITE_DESIGN_CARE_STATES as readonly string[]).includes(object.state) || object.state === 'submitted') invalid('設計調整狀態不正確。')
  return {
    requestId: positiveId(object.requestId, '需求識別'),
    state: object.state as Exclude<DesignCareState, 'submitted'>,
    reason: boundedText(object.reason, '狀態說明', 500),
    idempotencyKey: idempotencyKey(object.idempotencyKey),
  }
}

export async function changeManagedSiteDesignCareState(
  ownerUserId: number,
  projectId: number,
  actorUserId: number,
  input: unknown,
  dependencies: ManagedSiteDesignCareDependencies = {},
) {
  positiveId(ownerUserId, '擁有人識別')
  positiveId(projectId, '專案識別')
  positiveId(actorUserId, '操作者識別')
  const parsed = parseStateChange(input)
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const now = new Date((dependencies.clock || (() => new Date()))())
  if (!Number.isFinite(now.getTime())) invalid('伺服器時間設定不正確。')
  const stateFingerprint = stableFingerprint({ requestId: parsed.requestId, state: parsed.state, reason: parsed.reason })
  const auditFingerprint = stableFingerprint({
    scope: 'managed-site-design-care-state-idempotency-v1',
    ownerUserId,
    projectId,
    requestId: parsed.requestId,
    idempotencyKey: parsed.idempotencyKey,
  })
  const result = await managedRepository.transaction(async repository => {
    const project = await repository.findProject(ownerUserId, projectId)
    if (!project) notFound('Managed site project was not found.')
    const events = await repository.listAuditEvents(ownerUserId, projectId)
    const request = events.find(event => event.id === parsed.requestId && event.action === REQUEST_ACTION && record(event.metadata).schemaVersion === REQUEST_SCHEMA)
    if (!request) notFound()
    const current = currentState(request, events)
    if (current.state === parsed.state) {
      const exactReplay = events.find(event => event.action === STATE_ACTION && event.eventFingerprint === auditFingerprint && event.afterFingerprint === stateFingerprint)
      if (exactReplay) return { event: exactReplay, replayed: true }
    }
    if (!TRANSITIONS[current.state].includes(parsed.state)) conflict(`設計調整狀態不可從 ${current.state} 變更為 ${parsed.state}。`)
    const existing = await repository.findAuditEventByFingerprint(ownerUserId, auditFingerprint)
    if (existing) {
      if (existing.projectId !== projectId || existing.action !== STATE_ACTION || existing.afterFingerprint !== stateFingerprint || record(existing.metadata).requestEventId !== request.id) conflict('相同冪等識別已用於不同的狀態變更。')
      return { event: existing, replayed: true }
    }
    const beforeFingerprint = stableFingerprint({ requestId: request.id, state: current.state, reason: current.reason })
    const event = await repository.insertAuditEvent({
      ownerUserId,
      projectId,
      actorUserId,
      authority: 'owner_session',
      action: STATE_ACTION,
      beforeFingerprint,
      afterFingerprint: stateFingerprint,
      eventFingerprint: auditFingerprint,
      metadata: {
        schemaVersion: STATE_SCHEMA,
        requestEventId: request.id,
        previousState: current.state,
        state: parsed.state,
        reason: parsed.reason,
      },
      occurredAt: now,
    })
    if (event.projectId !== projectId || event.action !== STATE_ACTION || event.afterFingerprint !== stateFingerprint) conflict('相同冪等識別已用於不同的狀態變更。')
    return { event, replayed: false }
  })
  const projection = await getManagedSiteDesignCare(ownerUserId, projectId, { kind: 'owner' }, dependencies)
  const request = projection.requests.find(item => item.id === parsed.requestId)
  if (!request) notFound()
  return { care: projection, request, replayed: result.replayed }
}
