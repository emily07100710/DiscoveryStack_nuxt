import { createError } from 'h3'
import { createOwnerPublicationTarget } from '../../content-operations/orchestrator'
import { createContentOperationsRepository, type ContentOperationsRepository } from '../../content-operations/repository'
import { SIGNED_API_ENDPOINT_PATH } from '../../first-party-publishing/target-guard'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { linkManagedSiteContentOperations } from '../modules-service'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { managedSiteStableFingerprint } from '../live-connectors/canonical'
import { assertManagedSiteProductionPayment } from '../live-connectors/production-payment-authority'
import { getManagedSiteLiveConnectorRepository } from '../live-connectors/repository'
import type { ManagedSiteBlueprintSectionV1, ManagedSiteBlueprintV1, ManagedSiteLiveConnectorRepository } from '../live-connectors/types'
import { createInitialPage } from '../page-editor/canonical'
import { MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT, MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES, managedSiteCloudflareTargetId, managedSiteCloudflareTargetKey } from '../page-editor/native-target'
import { getDrizzlePageEditorRepository } from '../page-editor/repository-drizzle'
import type { PageActor, PageBlock, PageDocument, PageEditorRepository, RichTextNode } from '../page-editor/types'

export { managedSiteCloudflareTargetId, managedSiteCloudflareTargetKey } from '../page-editor/native-target'

type BootstrapInput = {
  releaseId: number
  timeZone?: string
  cadenceDays?: 3 | 7 | 15 | 30
  monthlyBudgetUnits?: number
}

type BootstrapDependencies = {
  liveRepository?: ManagedSiteLiveConnectorRepository
  managedRepository?: ManagedSiteRepository
  orderingRepository?: PreviewRepository
  operationsRepository?: ContentOperationsRepository
  pageRepository?: PageEditorRepository
  clock?: () => Date
  linkContentOperations?: typeof linkManagedSiteContentOperations
  createPublicationTarget?: typeof createOwnerPublicationTarget
  assertProductionPayment?: typeof assertManagedSiteProductionPayment
}

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function bounded(value: string, maximum: number): string {
  const normalized = value.normalize('NFC').trim()
  return Array.from(normalized).slice(0, maximum).join('').trim()
}

function paragraphNodes(value: string): RichTextNode[] {
  const characters = Array.from(value.normalize('NFC').trim())
  const nodes: RichTextNode[] = []
  for (let index = 0; index < characters.length && nodes.length < 80; index += 4000) {
    const text = characters.slice(index, index + 4000).join('').trim()
    if (text) nodes.push({ type: 'paragraph', text })
  }
  return nodes.length ? nodes : [{ type: 'paragraph', text: '內容待補充。' }]
}

function blockId(pageKey: string, sectionId: string, suffix = 'content'): string {
  return `block_${stableFingerprint({ pageKey, sectionId, suffix }).slice(0, 24)}`
}

function richTextBlock(pageKey: string, section: ManagedSiteBlueprintSectionV1): PageBlock {
  return {
    blockId: blockId(pageKey, section.sectionId),
    type: 'rich_text',
    visible: true,
    layoutVariant: 'prose',
    data: { nodes: [{ type: 'heading', level: 2, text: bounded(section.heading, 240) }, ...paragraphNodes(section.body)] },
    mediaBindingIds: [],
    schedule: null,
  }
}

function sectionBlocks(blueprint: ManagedSiteBlueprintV1, pageKey: string, section: ManagedSiteBlueprintSectionV1): PageBlock[] {
  let primary: PageBlock
  if (section.kind === 'hero') {
    primary = {
      blockId: blockId(pageKey, section.sectionId), type: 'hero', visible: true, layoutVariant: 'centered',
      data: { title: bounded(section.heading, 180), description: bounded(section.body, 600), alignment: 'center', ...(section.ctaLabel && section.ctaHref ? { primaryLink: { label: bounded(section.ctaLabel, 120), href: section.ctaHref } } : {}) },
      mediaBindingIds: [], schedule: null,
    }
  } else if (section.kind === 'services') {
    primary = {
      blockId: blockId(pageKey, section.sectionId), type: 'services', visible: true, layoutVariant: 'cards',
      data: { title: bounded(section.heading, 180), items: [{ id: `service-${stableFingerprint({ pageKey, sectionId: section.sectionId }).slice(0, 16)}`, title: bounded(section.heading, 160), description: bounded(section.body, 800) }] },
      mediaBindingIds: [], schedule: null,
    }
  } else if (section.kind === 'faq') {
    const items = blueprint.faq.length ? blueprint.faq : [{ question: section.heading, answer: section.body }]
    primary = {
      blockId: blockId(pageKey, section.sectionId), type: 'faq', visible: true, layoutVariant: 'accordion',
      data: { title: bounded(section.heading, 180), items: items.slice(0, 50).map((item, index) => ({ id: `faq-${stableFingerprint({ pageKey, question: item.question, index }).slice(0, 16)}`, question: bounded(item.question, 240), answer: bounded(item.answer, 2000) })) },
      mediaBindingIds: [], schedule: null,
    }
  } else if (section.kind === 'contact_form') {
    primary = {
      blockId: blockId(pageKey, section.sectionId), type: 'contact', visible: true, layoutVariant: 'form',
      data: { title: bounded(section.heading, 180), description: bounded(section.body, 800), fields: ['name', 'email', 'phone', 'message'], consentRequired: true },
      mediaBindingIds: [], schedule: null,
    }
  } else if (section.kind === 'blog_index') {
    primary = {
      blockId: blockId(pageKey, section.sectionId), type: 'article_list', visible: true, layoutVariant: 'cards',
      data: { title: bounded(section.heading, 180), source: 'latest', limit: 12 }, mediaBindingIds: [], schedule: null,
    }
  } else {
    primary = richTextBlock(pageKey, section)
  }
  if (section.kind === 'hero' || !section.ctaLabel || !section.ctaHref) return [primary]
  return [primary, {
    blockId: blockId(pageKey, section.sectionId, 'cta'), type: 'cta', visible: true, layoutVariant: 'band',
    data: { title: bounded(section.heading, 180), primaryLink: { label: bounded(section.ctaLabel, 120), href: section.ctaHref } },
    mediaBindingIds: [], schedule: null,
  }]
}

function contentType(pageKey: ManagedSiteBlueprintV1['pages'][number]['pageKey']): PageDocument['contentType'] {
  if (pageKey === 'home') return 'home'
  if (pageKey === 'services') return 'services'
  if (pageKey === 'contact') return 'contact'
  if (pageKey === 'blog') return 'articles'
  return 'standard'
}

export function managedSiteBlueprintPages(input: { ownerUserId: number; projectId: number; blueprint: ManagedSiteBlueprintV1; now: Date }): PageDocument[] {
  const actor: PageActor = { ownerUserId: input.ownerUserId, projectId: input.projectId, actorUserId: null, authority: 'system_workflow', role: 'platform_owner', canPublish: true }
  const blueprintFingerprint = managedSiteStableFingerprint(input.blueprint)
  return input.blueprint.pages.map(page => createInitialPage(actor, {
    pageId: `page_${stableFingerprint({ ownerUserId: input.ownerUserId, projectId: input.projectId, pageKey: page.pageKey, blueprintFingerprint }).slice(0, 40)}`,
    locale: input.blueprint.locale,
    route: page.route,
    contentType: contentType(page.pageKey),
    designThemeId: 'managed_site_default',
    designTokenVersion: 'tokens-v1',
    designTokens: { palette: 'indigo_sand', typeScale: 'balanced', spacing: 'balanced', radius: 'soft', maxWidth: 'standard', contrast: 'aa' },
    sections: page.sections.flatMap(section => sectionBlocks(input.blueprint, page.pageKey, section)),
    seo: { title: bounded(page.title, 240), description: bounded(page.description, 500), canonicalPath: page.route, noindex: false, ogBindingId: null },
    mediaBindings: [],
  }, input.now))
}

async function seedMissingPages(repository: PageEditorRepository, ownerUserId: number, projectId: number, pages: PageDocument[]) {
  const existing: PageDocument[] = []
  let cursor: PageDocument | undefined
  do {
    const batch = await repository.listPages(ownerUserId, projectId, { limit: 100, ...(cursor ? { afterRoute: cursor.route, afterPageId: cursor.pageId } : {}) })
    existing.push(...batch)
    cursor = batch.at(-1)
    if (batch.length < 100) break
    if (existing.length >= 1_000) conflict('Managed-site page inventory exceeds the bounded bootstrap limit.')
  } while (cursor)
  const byRoute = new Map(existing.map(page => [page.route, page]))
  const byIdentity = new Map(existing.map(page => [page.pageId, page]))
  const seeded: string[] = []
  for (const page of pages) {
    const identityMatch = byIdentity.get(page.pageId)
    if (identityMatch && identityMatch.route !== page.route) conflict('Managed-site generated page identity is already bound to a different route.')
    if (identityMatch || byRoute.has(page.route)) continue
    try {
      await repository.insertInitial(ownerUserId, projectId, page)
      byRoute.set(page.route, page)
      byIdentity.set(page.pageId, page)
      seeded.push(page.pageId)
    } catch (error) {
      // A concurrent bootstrap is safe only if this project now owns the exact route.
      const current = await repository.listPages(ownerUserId, projectId, { limit: 100 })
      const concurrentIdentity = current.find(candidate => candidate.pageId === page.pageId)
      if (concurrentIdentity && concurrentIdentity.route !== page.route) conflict('Managed-site generated page identity raced onto a different route.')
      const concurrentRoute = current.find(candidate => candidate.route === page.route)
      if (!concurrentRoute) throw error
      byRoute.set(page.route, concurrentRoute)
      byIdentity.set(concurrentRoute.pageId, concurrentRoute)
    }
  }
  return { seeded, existing: pages.length - seeded.length }
}

export async function bootstrapManagedSiteCustomerWorkspace(ownerUserId: number, input: BootstrapInput, dependencies: BootstrapDependencies = {}) {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || !Number.isSafeInteger(input.releaseId) || input.releaseId < 1) conflict('Customer workspace bootstrap authority is invalid.')
  const liveRepository = dependencies.liveRepository || getManagedSiteLiveConnectorRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const orderingRepository = dependencies.orderingRepository || getPreviewRepository()
  const operationsRepository = dependencies.operationsRepository || createContentOperationsRepository()
  const pageRepository = dependencies.pageRepository || getDrizzlePageEditorRepository()
  const clock = dependencies.clock || (() => new Date())
  const release = await liveRepository.findRelease(ownerUserId, input.releaseId)
  const project = release ? await managedRepository.findProject(ownerUserId, release.projectId) : null
  if (!release || !project || release.releaseKind !== 'generated_site' || !release.generationCandidateId || !['live_verified', 'geo_active'].includes(release.status) || !release.activeDeploymentReceiptFingerprint) conflict('Customer workspace bootstrap requires an exact verified generated-site release.')
  const [receipt, candidate] = await Promise.all([
    liveRepository.findReceiptByFingerprint(ownerUserId, release.activeDeploymentReceiptFingerprint),
    liveRepository.findGenerationCandidate(ownerUserId, release.generationCandidateId),
  ])
  if (!receipt || receipt.releaseId !== release.id || receipt.projectId !== project.id || receipt.receiptType !== 'production_deployment_verified' || receipt.receiptStatus !== 'verified' || receipt.contentHash !== release.contentHash || receipt.canonicalDomain !== release.canonicalDomain) conflict('Customer workspace bootstrap production authority is stale or mismatched.')
  if (!candidate || candidate.projectId !== project.id || candidate.sourceVersionId !== release.versionId || candidate.contentHash !== release.contentHash) conflict('Customer workspace bootstrap immutable candidate is stale or mismatched.')
  const assertPayment = dependencies.assertProductionPayment || assertManagedSiteProductionPayment
  await assertPayment(ownerUserId, release, liveRepository, orderingRepository, managedRepository)
  const manifest = candidate.manifest as Record<string, unknown>
  const blueprint = manifest.blueprint as ManagedSiteBlueprintV1 | undefined
  if (!blueprint || blueprint.schemaVersion !== 'managed-site-blueprint-v1' || manifest.blueprintHash !== managedSiteStableFingerprint(blueprint)) conflict('Customer workspace bootstrap blueprint authority is invalid.')

  const cadenceDays = input.cadenceDays || 30
  const monthlyBudgetUnits = Number.isSafeInteger(input.monthlyBudgetUnits) && input.monthlyBudgetUnits! > 0 ? input.monthlyBudgetUnits! : Math.max(1, Math.ceil(30 / cadenceDays))
  const link = dependencies.linkContentOperations || linkManagedSiteContentOperations
  const linked = await link(ownerUserId, project.id, {
    displayName: project.canonicalClientIdentity,
    canonicalSiteOrigin: `https://${release.canonicalDomain}`,
    framework: 'astro',
    publicationTransport: 'first_party_signed_api',
    timeZone: input.timeZone || 'Asia/Taipei',
    defaultCadenceDays: cadenceDays,
    defaultPublishLocalTime: '09:00',
    monthlyBudgetUnits,
    idempotencyKey: `managed-site-editor-client:${project.id}`,
  }, managedRepository, operationsRepository)
  const clientId = Number((linked as any).client?.id)
  const linkedProjectClientId = Number((linked as any).project?.contentOperationClientId)
  const linkedClient = (linked as any).client
  if (!Number.isSafeInteger(clientId) || clientId < 1 || linkedProjectClientId !== clientId || project.contentOperationClientId !== null && project.contentOperationClientId !== clientId || linkedClient?.ownerUserId !== ownerUserId || linkedClient?.status !== 'active' || linkedClient?.canonicalSiteOrigin !== `https://${release.canonicalDomain}` || linkedClient?.framework !== 'astro' || linkedClient?.publicationTransport !== 'first_party_signed_api') conflict('Managed site is linked to an incompatible Content Operations client.')

  const targetKey = managedSiteCloudflareTargetKey(project.id)
  const createTarget = dependencies.createPublicationTarget || createOwnerPublicationTarget
  const target = await createTarget(ownerUserId, clientId, {
    idempotencyKey: targetKey,
    framework: 'astro',
    transport: 'first_party_signed_api',
    targetOrigin: `https://${release.canonicalDomain}`,
    serviceReference: null,
    contentRoot: MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT,
    defaultBranch: null,
    repositoryOwner: null,
    repositoryName: null,
    endpointPath: SIGNED_API_ENDPOINT_PATH,
    credentialReference: targetKey,
    allowedContentTypes: [...MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES],
    allowedLanguages: [blueprint.locale],
    maximumPayloadBytes: 10_000_000,
    executionEnabled: true,
  }, operationsRepository)
  if ((target as any).target?.targetId !== managedSiteCloudflareTargetId(ownerUserId, clientId, project.id)) conflict('Managed-site native publication target identity is mismatched.')

  // Recheck immediately before materializing the customer-editable page projection.
  await assertPayment(ownerUserId, release, liveRepository, orderingRepository, managedRepository)
  const pages = managedSiteBlueprintPages({ ownerUserId, projectId: project.id, blueprint, now: clock() })
  const pageSeed = await seedMissingPages(pageRepository, ownerUserId, project.id, pages)
  const storedTarget = (target as any).target
  const requestFingerprint = stableFingerprint({ scope: 'managed-site-customer-workspace-bootstrap-v1', ownerUserId, projectId: project.id, releaseId: release.id, contentHash: release.contentHash, productionReceiptFingerprint: receipt.receiptFingerprint, clientId, targetId: storedTarget.id, targetIdentity: storedTarget.targetId, pageFingerprints: pages.map(page => page.fingerprint) })
  const receiptFingerprint = stableFingerprint({ requestFingerprint, completed: true })
  const bootstrapReceipt = await liveRepository.insertReceipt({
    ownerUserId,
    projectId: project.id,
    draftOrderId: release.draftOrderId,
    releaseId: release.id,
    attemptId: null,
    capability: 'deployment',
    providerKey: 'discoverystack-customer-workspace',
    providerEventId: `customer-workspace-${receiptFingerprint.slice(0, 32)}`,
    receiptType: 'customer_workspace_bootstrapped',
    receiptStatus: 'verified',
    externalReference: storedTarget.targetId,
    exactResponseIdentity: `customer-workspace:${receiptFingerprint.slice(0, 48)}`,
    requestFingerprint,
    contentHash: release.contentHash,
    canonicalDomain: release.canonicalDomain,
    metadata: { productionReceiptFingerprint: receipt.receiptFingerprint, clientId, targetRowId: storedTarget.id, targetId: storedTarget.targetId, pageIds: pages.map(page => page.pageId), insertOnly: true },
    receiptFingerprint,
    verifiedAt: clock(),
  } as any)
  return { projectId: project.id, releaseId: release.id, clientId, target: storedTarget, pages: { total: pages.length, ...pageSeed }, receipt: bootstrapReceipt, replayed: Boolean((linked as any).reused && (target as any).replayed && pageSeed.seeded.length === 0) }
}
