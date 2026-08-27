import { createError } from 'h3'
import { getDatabase } from '../database'
import { stableFingerprint } from '../seo-geo-core/repository'
import { makeOrderingRepository } from './ordering-repository'
import { getPreviewRepository } from './ordering-repository'
import type { PreviewRepository } from './ordering-types'
import { makeManagedSiteRepository } from './repository'
import { getManagedSiteRepository } from './repository'
import { createManagedSiteProject, createManagedSiteVersion } from './service'
import { parseSiteSpecSnapshot } from './site-spec'
import type { ManagedSiteActor, ManagedSiteRepository } from './types'
import { getManagedSiteLiveConnectorRepository, makeManagedSiteLiveConnectorRepository } from './live-connectors/repository'
import type { ManagedSiteLiveConnectorRepository } from './live-connectors/types'

type Repositories = { ordering: PreviewRepository; managed: ManagedSiteRepository; live: ManagedSiteLiveConnectorRepository }
type Input = { previewId: number; quoteId: number; leadIntentId: number; draftOrderId: number; idempotencyKey: string }

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function nonNested<T extends { transaction: (work: (repository: T) => Promise<unknown>) => Promise<unknown> }>(repository: T): T { return { ...repository, transaction: async work => work(repository) } as T }

export function managedSiteCommerceSnapshotFingerprint(input: { previewId: number; quoteId: number; draftOrderId: number; quoteVersion: string; totalMinor: number; currency: string; planKey: string; cadenceDays: number; domainOption: string; taxStatus: string; lines: Array<{ lineKey: string; quantity: number; unitAmountMinor: number; lineAmountMinor: number; lineFingerprint: string }> }): string {
  return stableFingerprint({ schemaVersion: 'managed-site-commerce-snapshot-v1', ...input, lines: [...input.lines].sort((left, right) => left.lineKey.localeCompare(right.lineKey)) })
}

async function convertWithin(ownerUserId: number, input: Input, repositories: Repositories, clock: () => Date) {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || ![input.previewId, input.quoteId, input.leadIntentId, input.draftOrderId].every(value => Number.isSafeInteger(value) && value > 0) || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) invalid('Pre-purchase conversion identity is invalid.')
  const [preview, quote, leadIntent, order, subscriptionIntent] = await Promise.all([repositories.ordering.findPreviewById(input.previewId), repositories.ordering.findQuoteById(input.quoteId), repositories.ordering.findLeadIntentById(input.leadIntentId), repositories.ordering.findDraftOrderById(input.draftOrderId), repositories.ordering.findSubscriptionIntentByQuote(input.quoteId)])
  if (!preview || !quote || !leadIntent || !order || !subscriptionIntent) conflict('Pre-purchase lineage is incomplete.')
  if ([preview.ownerUserId, quote.ownerUserId, leadIntent.ownerUserId, order.ownerUserId, subscriptionIntent.ownerUserId].some(value => value !== ownerUserId)) conflict('Pre-purchase lineage is not claimed by the exact owner session.')
  if (quote.previewId !== preview.id || leadIntent.previewId !== preview.id || leadIntent.quoteId !== quote.id || order.previewId !== preview.id || order.quoteId !== quote.id || order.leadId !== leadIntent.leadId || subscriptionIntent.quoteId !== quote.id) conflict('Pre-purchase identifiers do not describe one exact persisted lineage.')
  const now = clock()
  if (!Number.isFinite(now.getTime()) || !['generated', 'saved'].includes(preview.status) || quote.status !== 'quoted' || quote.expiresAt.getTime() <= now.getTime() || order.status !== 'payment_pending' || order.paymentIntentReference) conflict('Pre-purchase lineage is expired, paid, or no longer eligible.')
  const lines = await repositories.ordering.listQuoteLines(quote.id)
  if (!lines.length || lines.reduce((sum, line) => sum + line.lineAmountMinor, 0) !== quote.totalMinor || lines.some(line => line.quantity * line.unitAmountMinor !== line.lineAmountMinor)) conflict('Pre-purchase quote lines do not match the server-owned quote total.')
  const commerceSnapshotFingerprint = managedSiteCommerceSnapshotFingerprint({ previewId: preview.id, quoteId: quote.id, draftOrderId: order.id, quoteVersion: quote.quoteVersion, totalMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, taxStatus: quote.taxStatus, lines: lines.map(line => ({ lineKey: line.lineKey, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor, lineFingerprint: line.lineFingerprint })) })
  const spec = parseSiteSpecSnapshot(preview.siteSpecSnapshot)
  const projectKey = `prepurchase-order:${order.id}`
  const versionContentFingerprint = stableFingerprint({ schemaVersion: 'managed-site-prepurchase-source-v1', previewFingerprint: preview.previewFingerprint, siteSpecFingerprint: spec.deterministicFingerprint, commerceSnapshotFingerprint })
  const bindingRequestFingerprint = stableFingerprint({ ownerUserId, previewId: preview.id, quoteId: quote.id, leadIntentId: leadIntent.id, draftOrderId: order.id, versionContentFingerprint, commerceSnapshotFingerprint })
  if (order.projectId) {
    const project = await repositories.managed.findProject(ownerUserId, order.projectId)
    const versions = project ? await repositories.managed.listVersions(ownerUserId, project.id) : []
    const version = versions.find(item => item.createdByAuthority === 'owner_session' && item.lifecycleStatus === 'draft' && item.contentFingerprint === versionContentFingerprint)
    const subscription = project ? await repositories.managed.findSubscription(ownerUserId, project.id) : null
    const binding = project ? await repositories.live.findPrePurchaseBinding(ownerUserId, project.id) : null
    if (!project || !version || !binding || binding.previewId !== preview.id || binding.quoteId !== quote.id || binding.draftOrderId !== order.id || binding.sourceVersionId !== version.id || binding.commerceSnapshotFingerprint !== commerceSnapshotFingerprint || binding.requestFingerprint !== bindingRequestFingerprint || quote.projectId !== project.id || subscriptionIntent.projectId !== project.id || subscription) conflict('Pre-purchase replay lineage is partial or has an unexpected paid subscription.')
    return { project, version, binding, preview, quote, order, commerceSnapshotFingerprint, replayed: true, subscriptionActivated: false as const, paymentVerified: false as const }
  }
  const lead = await repositories.ordering.findLeadById(order.leadId)
  if (!lead) conflict('Pre-purchase lead identity is unavailable.')
  const actor: ManagedSiteActor = { ownerUserId, actorUserId: ownerUserId, authority: 'owner_session', role: 'owner', principal: `owner-session-prepurchase:${order.id}` }
  const managed = nonNested(repositories.managed)
  const created = await createManagedSiteProject(ownerUserId, actor, { canonicalClientIdentity: lead.company, canonicalWebsiteIdentity: lead.website || `managed-site://prepurchase/${order.id}`, siteType: spec.siteType, idempotencyKey: projectKey }, managed)
  const version = (await createManagedSiteVersion(ownerUserId, created.project.id, actor, { siteSpecSnapshot: spec, designTokenSnapshot: spec.designTokens, selectedModuleSnapshot: spec.selectedModules, contentFingerprint: versionContentFingerprint, createdByAuthority: 'owner_session', lifecycleStatus: 'draft' }, managed)).version
  await repositories.managed.updateProject(ownerUserId, created.project.id, { status: 'payment_pending', activeVersionId: null } as any)
  await repositories.ordering.updateDraftOrder(order.id, { projectId: created.project.id, updatedAt: now } as any)
  await repositories.ordering.updateQuote(quote.id, { projectId: created.project.id, updatedAt: now } as any)
  await repositories.ordering.updateSubscriptionIntent(quote.id, { projectId: created.project.id, updatedAt: now } as any)
  const binding = await repositories.live.insertPrePurchaseBinding({ ownerUserId, projectId: created.project.id, sourceVersionId: version.id, previewId: preview.id, quoteId: quote.id, draftOrderId: order.id, commerceSnapshotFingerprint, requestFingerprint: bindingRequestFingerprint, idempotencyKey: input.idempotencyKey } as any)
  const project = await repositories.managed.findProject(ownerUserId, created.project.id)
  const finalOrder = await repositories.ordering.findDraftOrderById(order.id)
  if (!project || !finalOrder || finalOrder.projectId !== project.id) conflict('Pre-purchase project binding could not be reloaded.')
  return { project, version, binding, preview, quote, order: finalOrder, commerceSnapshotFingerprint, replayed: created.replayed, subscriptionActivated: false as const, paymentVerified: false as const }
}

export async function convertClaimedManagedSitePrePurchase(ownerUserId: number, input: Input, repositories?: Repositories, clock: () => Date = () => new Date()) {
  if (repositories) return repositories.ordering.transaction(transaction => convertWithin(ownerUserId, input, { ordering: transaction, managed: repositories.managed, live: repositories.live }, clock))
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Pre-purchase conversion storage is unavailable.' })
  return database.transaction((transaction: any) => convertWithin(ownerUserId, input, { ordering: makeOrderingRepository(transaction), managed: makeManagedSiteRepository(transaction), live: makeManagedSiteLiveConnectorRepository(transaction) }, clock))
}

export function getManagedSitePrePurchaseRepositories(): Repositories { return { ordering: getPreviewRepository(), managed: getManagedSiteRepository(), live: getManagedSiteLiveConnectorRepository() } }
