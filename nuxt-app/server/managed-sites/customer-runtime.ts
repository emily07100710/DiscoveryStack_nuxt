import { createError } from 'h3'
import { managedSiteStableFingerprint } from './live-connectors/canonical'
import { parseSiteSpecSnapshot, type SiteSpec } from './site-spec'
import { getManagedSiteRepository } from './repository'
import type { ManagedSiteRepository } from './types'

export const CUSTOMER_RUNTIME_VERSION = 'customer-site-runtime-manifest-v1' as const
export const DESIGN_CARE_POLICY = { days: 30, startsAt: 'verified_delivery', included: ['layout', 'color', 'typography', 'image_placement'], excluded: ['new_features', 'data_migration', 'new_integrations', 'third_party_fees'], label: '正式交付後 30 天內，原功能範圍的排版、美術調整免費。新增功能、資料搬遷及第三方費用另行確認。' } as const

/** Converts approved data into an isolated engine, never into private-platform or AI source code. */
export function customerRuntimeManifest(spec: SiteSpec, identity: { ownerUserId: number; projectId: number; versionId: number }, input: { engine: 'commerce' | 'booking_blog'; mode: 'preview' | 'production' }) {
  if (!['commerce', 'booking_blog'].includes(input.engine) || !['preview', 'production'].includes(input.mode) || Object.values(identity).some(value => !Number.isSafeInteger(value) || value < 1)) throw createError({ statusCode: 422, statusMessage: '客戶網站核心或身份設定不正確。' })
  const preset = spec.customerSitePreset || (input.engine === 'commerce' ? 'atelier' : 'alignment')
  const config = {
    schemaVersion: 'customer-site-config-v1', siteId: `ds-${identity.ownerUserId}-${identity.projectId}`, siteType: input.engine, preset, mode: input.mode,
    brandName: spec.businessIdentity.brandName, description: spec.businessIdentity.brief, tagline: '',
    hero: { title: spec.businessIdentity.brandName, description: spec.businessIdentity.brief.slice(0, 800), eyebrow: '', image: '' },
    about: spec.businessIdentity.brief, contact: { email: '', phone: '', address: '' }, currency: 'TWD', policies: { shipping: '', returns: '', privacy: '' },
    commerce: { paymentMode: 'disabled', shippingFeeMinor: 0, freeShippingThresholdMinor: 0, orderHoldMinutes: 30, manualPaymentInstructions: '' },
    booking: { timeZone: 'Asia/Taipei', cancellationHours: 24, holdMinutes: 30 }, aftercare: DESIGN_CARE_POLICY,
  }
  const manifest = {
    schemaVersion: CUSTOMER_RUNTIME_VERSION, runtime: 'discoverystack-customer-site-runtime', runtimeVersion: '1.0.0',
    lineage: { ...identity, siteSpecFingerprint: spec.deterministicFingerprint }, config,
    isolation: { separateProcess: true, separateDatabase: true, separateAuth: true, databasePath: `/data/${config.siteId}/site.sqlite`, mediaPath: `/data/${config.siteId}/uploads`, copyPrivatePlatformDatabase: false },
    requiredSettings: ['SITE_ORIGIN', 'SITE_ADMIN_PASSWORD', 'SITE_SESSION_SECRET', 'SITE_DATABASE_PATH', 'SITE_UPLOADS_PATH'],
    launch: { status: 'configuration_ready', deployed: false, paymentVerified: false, databaseProvisioned: false, blocker: 'runtime_deployment_adapter_required', message: '已生成客戶網站核心設定；需要獨立 Node 託管與持久磁碟。現有靜態部署不會開通交易後台。' },
    migration: { automaticCustomerCopy: false, passwordsOrPaymentTokensImported: false },
    moduleAuthority: { fulfillsExistingShopifyOrder: false, replacesStaticRelease: false },
    capabilities: input.engine === 'commerce' ? ['catalog', 'cart', 'server_priced_orders', 'inventory', 'manual_payment_confirmation', 'fulfilment', 'merchant_admin', 'blog', 'media', 'contact_inbox'] : ['services', 'capacity_one_slots', 'members', 'credit_ledger', 'booking', 'cancellation', 'reschedule', 'guest_booking_requests', 'merchant_admin', 'blog', 'media', 'contact_inbox'],
  }
  return { ...manifest, manifestFingerprint: managedSiteStableFingerprint(manifest) }
}

export async function prepareCustomerRuntime(ownerUserId: number, projectId: number, input: unknown, repository: ManagedSiteRepository = getManagedSiteRepository()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['versionId', 'engine', 'mode'].includes(key))) throw createError({ statusCode: 422, statusMessage: '客戶網站生成設定格式不正確。' })
  const request = input as { versionId: number; engine: 'commerce' | 'booking_blog'; mode: 'preview' | 'production' }
  if (!Number.isSafeInteger(request.versionId) || request.versionId < 1 || !['commerce', 'booking_blog'].includes(request.engine) || !['preview', 'production'].includes(request.mode)) throw createError({ statusCode: 422, statusMessage: '請選擇有效的版本、網站類型與模式。' })
  const [project, version] = await Promise.all([repository.findProject(ownerUserId, projectId), repository.findVersion(ownerUserId, request.versionId)])
  if (!project || project.ownerUserId !== ownerUserId || !version || version.ownerUserId !== ownerUserId || version.projectId !== project.id) throw createError({ statusCode: 404, statusMessage: '找不到此專案的網站版本。' })
  if (project.status === 'suspended') throw createError({ statusCode: 409, statusMessage: '專案已暫停，請先處理專案狀態。' })
  const spec = parseSiteSpecSnapshot(version.siteSpecSnapshot)
  const manifest = customerRuntimeManifest(spec, { ownerUserId, projectId, versionId: version.id }, request)
  await repository.insertAuditEvent({ ownerUserId, projectId, actorUserId: ownerUserId, authority: 'owner_session', action: 'customer_runtime_configuration_prepared', beforeFingerprint: version.versionFingerprint, afterFingerprint: manifest.manifestFingerprint, eventFingerprint: managedSiteStableFingerprint({ scope: 'customer-runtime-preparation', ownerUserId, projectId, manifestFingerprint: manifest.manifestFingerprint }), metadata: { manifestFingerprint: manifest.manifestFingerprint, engine: request.engine, mode: request.mode, versionId: version.id, deployed: false, paymentVerified: false } })
  return manifest
}
