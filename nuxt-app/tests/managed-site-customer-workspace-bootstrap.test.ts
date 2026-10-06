import { describe, expect, it, vi } from 'vitest'
import { bootstrapManagedSiteCustomerWorkspace, managedSiteBlueprintPages } from '../server/managed-sites/funnel/customer-workspace-bootstrap'
import { managedSiteStableFingerprint } from '../server/managed-sites/live-connectors/canonical'
import type { ManagedSiteBlueprintV1 } from '../server/managed-sites/live-connectors/types'
import { createMemoryPageEditorRepository } from '../server/managed-sites/page-editor/memory-repository'
import { MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT, MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES, managedSiteCloudflareTargetId, managedSiteCloudflareTargetKey } from '../server/managed-sites/page-editor/native-target'

const NOW = new Date('2031-02-03T04:05:06.000Z')

function blueprint(brandName = 'Customer Studio'): ManagedSiteBlueprintV1 {
  return {
    schemaVersion: 'managed-site-blueprint-v1', brandName, locale: 'zh-hant', siteType: 'brand_blog',
    navigation: [{ label: '首頁', route: '/' }, { label: '服務', route: '/services' }],
    pages: [
      { pageKey: 'home', route: '/', title: `${brandName} 首頁`, description: '可編輯的首頁。', sections: [{ sectionId: 'home-hero', kind: 'hero', heading: brandName, body: '以可追溯內容建立網站。', ctaLabel: '看服務', ctaHref: '/services', moduleKey: null, formEndpoint: null }] },
      { pageKey: 'services', route: '/services', title: `${brandName} 服務`, description: '服務說明。', sections: [{ sectionId: 'services-list', kind: 'services', heading: '服務', body: '顧問與內容服務。', ctaLabel: null, ctaHref: null, moduleKey: null, formEndpoint: null }] },
    ],
    faq: [], selectedModulePlacements: [],
    seoGeo: { summaryAnswer: 'Customer Studio 提供受控網站內容服務。', canonicalPlaceholder: '{{CANONICAL_ORIGIN}}', organizationName: brandName, evidenceLimitations: ['尚未取得成效證據。'], structuredDataKinds: ['Organization', 'Service'] },
    provenance: { evidenceSnapshotHash: 'a'.repeat(64), authoritySourceIds: ['source-customer'], providerContentHash: 'b'.repeat(64) },
  }
}

function fixture() {
  const source = blueprint()
  const release = { id: 31, ownerUserId: 7, projectId: 11, versionId: 13, draftOrderId: 17, quoteId: 19, previewId: 23, releaseKind: 'generated_site', generationCandidateId: 29, status: 'live_verified', activeDeploymentReceiptFingerprint: 'production-receipt', contentHash: 'c'.repeat(64), canonicalDomain: 'customer-studio.tw' }
  const project = { id: 11, ownerUserId: 7, status: 'active', canonicalClientIdentity: 'Customer Studio', contentOperationClientId: null }
  const productionReceipt = { receiptFingerprint: 'production-receipt', releaseId: 31, projectId: 11, receiptType: 'production_deployment_verified', receiptStatus: 'verified', contentHash: release.contentHash, canonicalDomain: release.canonicalDomain }
  const candidate = { id: 29, ownerUserId: 7, projectId: 11, sourceVersionId: 13, contentHash: release.contentHash, manifest: { blueprint: source, blueprintHash: managedSiteStableFingerprint(source) } }
  const insertedReceipts: any[] = []
  const liveRepository = {
    findRelease: vi.fn(async () => release),
    findReceiptByFingerprint: vi.fn(async () => productionReceipt),
    findGenerationCandidate: vi.fn(async () => candidate),
    insertReceipt: vi.fn(async (input: any) => {
      const existing = insertedReceipts.find(row => row.providerEventId === input.providerEventId)
      if (existing) return existing
      const stored = { id: insertedReceipts.length + 1, ...input }
      insertedReceipts.push(stored)
      return stored
    }),
  } as any
  const managedRepository = { findProject: vi.fn(async () => project) } as any
  const linkedProject = { ...project, contentOperationClientId: 41 }
  const client = { id: 41, ownerUserId: 7, status: 'active', canonicalSiteOrigin: 'https://customer-studio.tw', framework: 'astro', publicationTransport: 'first_party_signed_api' }
  const linkContentOperations = vi.fn(async () => ({ project: linkedProject, client, reused: true })) as any
  const targetId = managedSiteCloudflareTargetId(7, 41, 11)
  const createPublicationTarget = vi.fn(async (_ownerUserId: number, _clientId: number, input: any) => ({ target: { id: 43, clientId: 41, targetId, ...input, status: 'active' }, replayed: insertedReceipts.length > 0 })) as any
  const assertProductionPayment = vi.fn(async () => undefined) as any
  return { source, release, project, liveRepository, managedRepository, orderingRepository: {} as any, pageRepository: createMemoryPageEditorRepository(), operationsRepository: {} as any, linkContentOperations, createPublicationTarget, assertProductionPayment, insertedReceipts }
}

describe('managed-site paid customer workspace bootstrap', () => {
  it('creates the reserved native target and inserts only missing blueprint routes', async () => {
    const f = fixture()
    const existing = managedSiteBlueprintPages({ ownerUserId: 7, projectId: 11, blueprint: blueprint('Customer edited copy'), now: NOW })[0]!
    await f.pageRepository.insertInitial(7, 11, existing)

    const result = await bootstrapManagedSiteCustomerWorkspace(7, { releaseId: 31, timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 5 }, { ...f, clock: () => NOW })

    expect(result.pages).toMatchObject({ total: 2, seeded: [expect.any(String)], existing: 1 })
    const pages = await f.pageRepository.listPages(7, 11)
    expect(pages).toHaveLength(2)
    expect(pages.find(page => page.route === '/')).toEqual(existing)
    expect(pages.find(page => page.route === '/services')).toMatchObject({ version: 1, actorAuthority: 'system_workflow:system:platform_owner', publicationState: 'draft' })
    expect(f.createPublicationTarget).toHaveBeenCalledWith(7, 41, expect.objectContaining({
      idempotencyKey: managedSiteCloudflareTargetKey(11), credentialReference: managedSiteCloudflareTargetKey(11),
      contentRoot: MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT, allowedContentTypes: [...MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES],
      targetOrigin: 'https://customer-studio.tw', executionEnabled: true,
    }), f.operationsRepository)
    expect(f.assertProductionPayment).toHaveBeenCalledTimes(2)
    expect(f.insertedReceipts).toHaveLength(1)
    expect(f.insertedReceipts[0]).toMatchObject({ receiptType: 'customer_workspace_bootstrapped', receiptStatus: 'verified', metadata: expect.objectContaining({ clientId: 41, targetRowId: 43, targetId: managedSiteCloudflareTargetId(7, 41, 11), insertOnly: true }) })

    await bootstrapManagedSiteCustomerWorkspace(7, { releaseId: 31, cadenceDays: 7 }, { ...f, clock: () => NOW })
    expect((await f.pageRepository.listPages(7, 11)).find(page => page.route === '/')).toEqual(existing)
    expect(await f.pageRepository.listPages(7, 11)).toHaveLength(2)
    expect(f.insertedReceipts).toHaveLength(1)
  })

  it('binds generated page identities to owner and project and rejects same-project identity drift', async () => {
    const source = blueprint()
    const first = managedSiteBlueprintPages({ ownerUserId: 7, projectId: 11, blueprint: source, now: NOW })
    const otherProject = managedSiteBlueprintPages({ ownerUserId: 7, projectId: 12, blueprint: source, now: NOW })
    const otherOwner = managedSiteBlueprintPages({ ownerUserId: 8, projectId: 11, blueprint: source, now: NOW })
    expect(first[0]!.pageId).not.toBe(otherProject[0]!.pageId)
    expect(first[0]!.pageId).not.toBe(otherOwner[0]!.pageId)

    const f = fixture()
    const moved = { ...first[0]!, route: '/moved', seo: { ...first[0]!.seo, canonicalPath: '/moved' } }
    // The memory boundary does not recalculate fingerprints, which lets this test model a corrupt legacy row.
    await f.pageRepository.insertInitial(7, 11, moved)
    await expect(bootstrapManagedSiteCustomerWorkspace(7, { releaseId: 31 }, { ...f, clock: () => NOW })).rejects.toMatchObject({ statusCode: 409 })
    expect(f.createPublicationTarget).toHaveBeenCalledTimes(1)
    expect(f.insertedReceipts).toHaveLength(0)
  })

  it('fails before workspace writes when exact current payment authority is absent', async () => {
    const f = fixture()
    f.assertProductionPayment.mockRejectedValueOnce(Object.assign(new Error('refunded'), { statusCode: 409 }))
    await expect(bootstrapManagedSiteCustomerWorkspace(7, { releaseId: 31 }, { ...f, clock: () => NOW })).rejects.toMatchObject({ statusCode: 409 })
    expect(f.linkContentOperations).not.toHaveBeenCalled()
    expect(f.createPublicationTarget).not.toHaveBeenCalled()
    expect(await f.pageRepository.listPages(7, 11)).toEqual([])
    expect(f.insertedReceipts).toHaveLength(0)
  })
})
