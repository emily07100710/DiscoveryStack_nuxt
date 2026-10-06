import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { FirstPartyPublishTarget } from '../server/first-party-publishing'
import {
  contentOperationCalendarEntries,
  contentOperationCalendars,
  contentOperationClients,
  contentOperationPublicationAttempts,
  contentOperationPublicationTargets,
  contentOperationRuns,
  managedSiteConnectorReceipts,
  managedSiteDraftOrders,
  managedSiteGenerationCandidates,
  managedSitePagePublicationWorks,
  managedSitePages,
  managedSiteProjects,
  managedSiteQuoteLines,
  managedSiteQuotes,
  managedSiteReleaseProjections,
  seoGeoContentDrafts,
  seoGeoContentJobs,
  seoGeoContentReviews,
  seoGeoContentRiskGates,
} from '../server/database/schema'
import { buildPublicationIdentity } from '../server/content-operations/publication-identity'
import { compilePageDocument } from '../server/managed-sites/page-editor/compiler'
import { createInitialPage } from '../server/managed-sites/page-editor/canonical'
import {
  assertManagedSiteNativePaymentReceiptAuthority,
  assertNoCompetingManagedSiteNativePublication,
  classifyManagedSiteNativePublicationFailure,
  executeManagedSiteNativePublicationIfConfigured,
  managedSiteNativeArticleEntryId,
} from '../server/managed-sites/page-editor/native-publication'
import {
  MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT,
  MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES,
  managedSiteCloudflareTargetId,
  managedSiteCloudflareTargetKey,
} from '../server/managed-sites/page-editor/native-target'
import { managedPageRouteSlug, serializeManagedPageTransport } from '../server/managed-sites/page-editor/transport'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import type { PageActor } from '../server/managed-sites/page-editor/types'
import { makePublication, makeSignedTarget, sha256 } from './fixtures/first-party-publishing/fixtures'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const nativeSource = readFileSync(new URL('../server/managed-sites/page-editor/native-publication.ts', import.meta.url), 'utf8')
const orchestratorSource = readFileSync(new URL('../server/content-operations/orchestrator.ts', import.meta.url), 'utf8')
const projectId = 7

function nativeTarget(overrides: Partial<FirstPartyPublishTarget> = {}): FirstPartyPublishTarget {
  return makeSignedTarget({
    targetId: managedSiteCloudflareTargetId(1, 4, projectId),
    framework: 'astro',
    targetOrigin: 'https://managed.example.com',
    contentRoot: MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT,
    credentialReference: managedSiteCloudflareTargetKey(projectId),
    allowedContentTypes: [...MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES],
    ...overrides,
  })
}

function paymentReceipts() {
  const contentHash = sha256('immutable paid release')
  const exact = { releaseId: 11, projectId, contentHash, canonicalDomain: 'managed.example.com' }
  return {
    exact,
    receipts: [
      { ...exact, receiptFingerprint: 'a'.repeat(64), receiptType: 'checkout_succeeded', receiptStatus: 'verified', metadata: { effective: true } },
      { ...exact, receiptFingerprint: 'b'.repeat(64), receiptType: 'release_payment_bound', receiptStatus: 'verified', metadata: { paymentReceiptFingerprint: 'a'.repeat(64) } },
    ],
  }
}

async function integratedNativeFixture(options: { bootstrapAuthority?: boolean; articleAuthority?: 'valid' | 'review_changed' | 'risk_changed'; inventoryChanged?: boolean } = {}) {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ siteType: 'one_page', canonicalDomain: 'native-edited.acme.taipei' })
  const webhookSecret = 'native-publication-webhook-secret'
  const event = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: `native-publication-payment-${options.bootstrapAuthority === false ? 'missing' : 'ready'}`, eventType: 'checkout_succeeded' })
  const rawBody = Buffer.from(JSON.stringify(event))
  await processManagedSiteRawPaymentWebhook({
    rawBody,
    signatureHeader: createHmac('sha256', webhookSecret).update(rawBody).digest('hex'),
    credentialReference: 'vault:native-publication-webhook',
    executionMode: 'mocked',
  }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), {
    jointTransaction: line.jointTransaction,
    credentialResolver: async () => ({ ok: true, value: webhookSecret }),
    clock: () => managedSiteFixedNow,
  })

  const ownerUserId = line.ownerUserId
  const release = line.live.state.releases.find(row => row.id === line.release.release.id)!
  const project = line.managed.state.projects.find(row => row.id === release.projectId)!
  const candidate = line.live.state.candidates.find(row => row.id === release.generationCandidateId)!
  const originalVaultReference = candidate.vaultReference
  const bundle = line.vault.records.get(originalVaultReference)!
  const strictVaultReference = `vault:s3:${ownerUserId}:${project.id}:${candidate.requestFingerprint}`
  candidate.vaultReference = strictVaultReference

  const productionReceiptFingerprint = sha256(`native-production:${release.id}`)
  const productionReceipt = await line.live.repository.insertReceipt({
    ownerUserId,
    projectId: project.id,
    draftOrderId: release.draftOrderId,
    releaseId: release.id,
    attemptId: null,
    capability: 'deployment',
    providerKey: 'mock-native-deployment',
    providerEventId: `native-production-${release.id}`,
    receiptType: 'production_deployment_verified',
    receiptStatus: 'verified',
    externalReference: `native-production-${release.id}`,
    exactResponseIdentity: `native-production-response:${release.id}`,
    requestFingerprint: sha256(`native-production-request:${release.id}`),
    contentHash: release.contentHash,
    canonicalDomain: release.canonicalDomain,
    metadata: {},
    receiptFingerprint: productionReceiptFingerprint,
    verifiedAt: managedSiteFixedNow,
  })
  release.status = 'live_verified'
  release.activeDeploymentReceiptFingerprint = productionReceiptFingerprint

  const clientId = 77
  const targetRowId = 88
  const canonicalOrigin = `https://${release.canonicalDomain}`
  const targetKey = managedSiteCloudflareTargetKey(project.id)
  const targetId = managedSiteCloudflareTargetId(ownerUserId, clientId, project.id)
  project.contentOperationClientId = clientId
  const client = { id: clientId, ownerUserId, status: 'active', canonicalSiteOrigin: canonicalOrigin, framework: 'astro', publicationTransport: 'first_party_signed_api' }
  const targetRow = {
    id: targetRowId,
    ownerUserId,
    clientId,
    websiteId: `managed-site-${project.id}`,
    targetId,
    destinationPublicationIdentity: targetKey,
    framework: 'astro',
    transport: 'first_party_signed_api',
    targetOrigin: canonicalOrigin,
    contentRoot: MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT,
    defaultBranch: 'main',
    repositoryOwner: null,
    repositoryName: null,
    endpointPath: '/api/first-party/content-ingest',
    serviceReference: targetKey,
    credentialReference: targetKey,
    allowedContentTypes: [...MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES],
    allowedLanguages: ['en', 'zh-hant'],
    maximumPayloadBytes: 1_000_000,
    status: 'active',
    executionEnabled: true,
    activeSlot: 1,
    configurationFingerprint: sha256(`native-target:${project.id}`),
    provenance: {},
    idempotencyKey: targetKey,
    createdAt: managedSiteFixedNow,
    updatedAt: managedSiteFixedNow,
    revokedAt: null,
  }
  const target = makeSignedTarget({
    targetId,
    ownerScopeKey: `owner-${sha256(String(ownerUserId)).slice(0, 32)}`,
    framework: 'astro',
    targetOrigin: canonicalOrigin,
    contentRoot: MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT,
    credentialReference: targetKey,
    allowedContentTypes: [...MANAGED_SITE_CLOUDFLARE_CONTENT_TYPES],
  })
  const bootstrapReceipt = {
    id: 90_001,
    ownerUserId,
    projectId: project.id,
    draftOrderId: release.draftOrderId,
    releaseId: release.id,
    attemptId: null,
    capability: 'deployment',
    providerKey: 'discoverystack-customer-workspace',
    providerEventId: `native-bootstrap-${release.id}`,
    receiptType: 'customer_workspace_bootstrapped',
    receiptStatus: 'verified',
    externalReference: targetId,
    exactResponseIdentity: `native-bootstrap-response:${release.id}`,
    requestFingerprint: sha256(`native-bootstrap-request:${release.id}`),
    contentHash: release.contentHash,
    canonicalDomain: release.canonicalDomain,
    metadata: { productionReceiptFingerprint, clientId, targetRowId, targetId, insertOnly: true },
    receiptFingerprint: sha256(`native-bootstrap:${release.id}`),
    verifiedAt: managedSiteFixedNow,
  }

  const actor: PageActor = { ownerUserId, projectId: project.id, actorUserId: null, authority: 'system_test', role: 'platform_owner', canPublish: true }
  const document = createInitialPage(actor, {
    pageId: 'page_native_home_0001',
    locale: 'zh-hant',
    route: '/',
    contentType: 'home',
    designThemeId: 'default',
    designTokenVersion: 'tokens-v1',
    designTokens: { palette: 'indigo_sand', typeScale: 'balanced', spacing: 'balanced', radius: 'soft', maxWidth: 'standard', contrast: 'aa' },
    sections: [{ blockId: 'block_native_hero_0001', type: 'hero', visible: true, layoutVariant: 'centered', data: { title: '已由客戶完成編輯', description: '這是付款後工作台保存的最新版首頁。', alignment: 'center' }, mediaBindingIds: [], schedule: null }],
    seo: { title: '客戶編輯後首頁', description: '經過權限與付款驗證後發布的單頁網站。', canonicalPath: '/', noindex: false, ogBindingId: null },
    mediaBindings: [],
  }, managedSiteFixedNow)
  const artifact = await compilePageDocument({ actor, document, resolveMedia: async () => { throw new Error('media lookup is not expected') }, mode: 'publish', now: managedSiteFixedNow, generatedAt: managedSiteFixedNow })
  const body = serializeManagedPageTransport(artifact)!
  const contentHash = sha256(body)
  const work = {
    id: 91,
    ownerUserId,
    projectId: project.id,
    clientId,
    pageId: document.pageId,
    pageVersion: document.version,
    releaseId: release.id,
    publicationTargetId: targetRowId,
    operationKind: 'publish',
    artifact,
    artifactBytes: Buffer.byteLength(body),
    artifactFingerprint: artifact.artifactFingerprint,
    mediaSetFingerprint: artifact.mediaSetFingerprint,
    pageFingerprint: document.fingerprint,
    contentHash,
    idempotencyKey: 'native-page-publish-0001',
    requestFingerprint: sha256('native-page-publish-request'),
    status: 'leased',
    attemptCount: 1,
    maxAttempts: 5,
    availableAt: managedSiteFixedNow,
    leaseOwner: 'native-test-worker',
    leaseUntil: new Date(managedSiteFixedNow.getTime() + 60_000),
    lastErrorCode: null,
    createdAt: managedSiteFixedNow,
    updatedAt: managedSiteFixedNow,
  }
  const identity = `managed-page-${work.pageId}-v${work.pageVersion}`
  const pagePublication = makePublication({
    ownerScopeKey: target.ownerScopeKey,
    scheduleEntryId: `entry-${identity}`,
    productionPlanId: `plan-managed-release-${release.id}`,
    productionDeliverableId: `deliverable-${identity}`,
    jobId: `job-${identity}`,
    draftId: `draft-${identity}`,
    draftVersion: work.pageVersion,
    reviewId: `review-customer-confirmed-${work.id}`,
    evidenceSnapshotHash: document.fingerprint,
    contentHash,
    title: document.seo.title,
    body,
    slug: managedPageRouteSlug(document.route)!,
    contentType: 'managed_page',
    language: document.locale,
    scheduledAt: work.createdAt.toISOString(),
    scheduleKey: `managed-page:${work.pageId}:${work.pageVersion}:${work.operationKind}`,
    authoritySourceIds: [`managed-site-release-${release.id}`, `page-version-${work.pageVersion}`],
    ruleIds: ['managed-site-page-publish-v1', 'page-content-home', 'customer-confirmed-draft-v1'],
  })

  const articleBody = '這是一篇經過付款、證據、人工審核與風險閘門確認的文章。'
  const articleBodyHash = sha256(articleBody)
  const articleEvidenceHash = sha256('native-article-evidence')
  const articleDraftHash = sha256('native-article-draft-record')
  const articleEntryId = 501
  const articleCalendar = { id: 502, ownerUserId, clientId, productionPlanId: 503 }
  const articleJob = { id: 504, ownerUserId, productionPlanId: articleCalendar.productionPlanId, productionDeliverableId: 505, strategyRecommendationId: 506, evidenceSnapshotHash: articleEvidenceHash }
  const articleDraft = { id: 507, jobId: articleJob.id, version: 3, title: '客戶核准的最新文章', body: articleBody, contentHash: articleDraftHash, safetyStatus: 'passed', provenance: { stage: 'optimized' } }
  const articleReview = { id: 508, jobId: articleJob.id, draftId: articleDraft.id, reviewerUserId: ownerUserId, decision: 'approved_for_delivery', evidenceSnapshotHash: articleEvidenceHash }
  const articleGate = { id: 509, draftId: articleDraft.id, status: 'passed', evidenceSnapshotHash: articleEvidenceHash }
  const identityResult = buildPublicationIdentity({ clientId, entryId: articleEntryId, targetId, targetOrigin: canonicalOrigin, contentRoot: MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT, contentType: 'article', language: 'zh-hant', title: articleDraft.title, ownerScopeKey: target.ownerScopeKey })
  if (!identityResult.ok) throw new Error(`article identity fixture failed: ${identityResult.reason}`)
  const articleIdentity = identityResult.identity
  const articleEntry = {
    id: articleEntryId,
    ownerUserId,
    calendarId: articleCalendar.id,
    productionDeliverableId: articleJob.productionDeliverableId,
    strategyRecommendationId: articleJob.strategyRecommendationId,
    jobId: articleJob.id,
    draftId: articleDraft.id,
    reviewId: articleReview.id,
    scheduleKey: 'native-article-schedule-001',
    contentType: 'article',
    language: 'zh-hant',
    evidenceSnapshotHash: articleEvidenceHash,
    contentHash: articleDraftHash,
    publicationContentHash: articleBodyHash,
    publicationTargetId: targetRowId,
    publicationSlug: articleIdentity.slug,
    publicationPath: articleIdentity.path,
    publicationAuthorityReference: null,
    status: 'publishing',
  }
  const articleAttempt = {
    id: 510,
    ownerUserId,
    clientId,
    entryId: articleEntry.id,
    runId: 511,
    targetId: targetRowId,
    websiteId: targetRow.websiteId,
    authorityReference: null,
    receiptFingerprint: null,
    attemptNumber: 1,
    mode: 'execute',
    idempotencyKey: 'native-article-attempt-001',
    inputFingerprint: sha256('native-article-attempt-input'),
    publicationId: articleIdentity.publicationId,
    publicationSlug: articleIdentity.slug,
    publicationPath: articleIdentity.path,
    contentHash: articleDraftHash,
    publicationContentHash: articleBodyHash,
    evidenceSnapshotHash: articleEvidenceHash,
    artifactFingerprint: null,
    status: 'planned',
  }
  const articleRun = {
    id: articleAttempt.runId,
    ownerUserId,
    entryId: articleEntry.id,
    stage: 'publication',
    state: 'processing',
    leaseOwner: 'native-article-worker',
    leaseExpiresAt: new Date(managedSiteFixedNow.getTime() + 60_000),
  }
  const deliveredInventoryAttempt = {
    ...articleAttempt,
    id: articleAttempt.id + 1,
    status: 'delivered',
    receiptFingerprint: sha256('native-article-delivered-receipt'),
    artifactFingerprint: sha256('native-article-delivered-artifact'),
  }
  const articlePublication = makePublication({
    ownerScopeKey: target.ownerScopeKey,
    scheduleEntryId: `entry-${articleEntry.id}`,
    productionPlanId: `plan-${articleCalendar.productionPlanId}`,
    productionDeliverableId: `deliverable-${articleJob.productionDeliverableId}`,
    jobId: `job-${articleJob.id}`,
    draftId: `draft-${articleDraft.id}`,
    draftVersion: articleDraft.version,
    reviewId: `review-${articleReview.id}`,
    reviewDecision: 'approved_for_delivery',
    riskGateStatus: 'passed',
    evidenceSnapshotHash: articleEvidenceHash,
    contentHash: articleBodyHash,
    title: articleDraft.title,
    body: articleBody,
    slug: articleIdentity.slug,
    contentType: 'article',
    language: 'zh-hant',
    scheduledAt: managedSiteFixedNow.toISOString(),
    scheduleKey: articleEntry.scheduleKey,
    authoritySourceIds: ['native-article-approved-source'],
    ruleIds: ['native-article-approved-rule'],
  })
  const publication = options.articleAuthority ? articlePublication : pagePublication

  const order = line.ordering.state.orders.find(row => row.id === release.draftOrderId)!
  const quote = line.ordering.state.quotes.find(row => row.id === release.quoteId)!
  const quoteLines = line.ordering.state.lines.filter(row => row.quoteId === quote.id)
  const paidReceipts = line.live.state.receipts.filter(row => row.draftOrderId === release.draftOrderId)
  const tableCalls = new Map<unknown, number>()
  const rows = (table: unknown) => {
    const index = tableCalls.get(table) || 0
    tableCalls.set(table, index + 1)
    if (table === contentOperationPublicationTargets) return [targetRow]
    if (table === managedSiteReleaseProjections) return [release]
    if (table === managedSiteProjects) return [project]
    if (table === contentOperationClients) return [client]
    if (table === managedSiteGenerationCandidates) return [candidate]
    if (table === managedSiteConnectorReceipts) {
      if (index === 0) return [productionReceipt]
      if (index === 1) return options.bootstrapAuthority === false ? [] : [bootstrapReceipt]
      return paidReceipts
    }
    if (table === contentOperationPublicationAttempts) {
      if (options.articleAuthority) {
        if ([0, 3, 6].includes(index)) return [articleAttempt]
        if (index === 5 && options.inventoryChanged) return [deliveredInventoryAttempt]
        return []
      }
      return index === 3 && options.inventoryChanged ? [deliveredInventoryAttempt] : []
    }
    if (table === contentOperationRuns) return options.articleAuthority ? [articleRun] : []
    if (table === contentOperationCalendarEntries) return options.articleAuthority ? [articleEntry] : []
    if (table === contentOperationCalendars) return options.articleAuthority ? [articleCalendar] : []
    if (table === seoGeoContentJobs) return options.articleAuthority ? [articleJob] : []
    if (table === seoGeoContentDrafts) return options.articleAuthority ? [articleDraft] : []
    if (table === seoGeoContentReviews) {
      if (!options.articleAuthority) return []
      if (index === 1 && options.articleAuthority === 'review_changed') return [{ ...articleReview, id: articleReview.id + 100, decision: 'changes_requested' }]
      return [articleReview]
    }
    if (table === seoGeoContentRiskGates) {
      if (!options.articleAuthority) return []
      if (index === 1 && options.articleAuthority === 'risk_changed') return [{ ...articleGate, id: articleGate.id + 100, status: 'blocked' }]
      return [articleGate]
    }
    if (table === managedSitePages) return []
    if (table === managedSitePagePublicationWorks) return options.articleAuthority ? [] : [0, 2, 4].includes(index) ? [work] : []
    if (table === managedSiteDraftOrders) return [order]
    if (table === managedSiteQuotes) return [quote]
    if (table === managedSiteQuoteLines) return quoteLines
    return []
  }
  const database: any = {
    select() {
      let table: unknown
      const builder: any = {
        from(value: unknown) { table = value; return builder },
        where() { return builder },
        orderBy() { return builder },
        limit() { return builder },
        for() { return Promise.resolve(rows(table)) },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(rows(table)).then(resolve, reject) },
      }
      return builder
    },
    transaction(run: (transaction: any) => Promise<unknown>) { return run(database) },
  }
  const vault = {
    async lookupImmutableCandidate(input: { ownerUserId: number; projectId: number; requestFingerprint: string }) {
      if (input.ownerUserId !== ownerUserId || input.projectId !== project.id || input.requestFingerprint !== candidate.requestFingerprint) return null
      return { bundle: structuredClone(bundle), vaultReference: strictVaultReference, exactResponseIdentity: 'native-vault-fixture' }
    },
    async storeImmutableCandidate() { throw new Error('native publication must not store a new candidate') },
  }
  return { database, vault, target, publication, work, release, canonicalOrigin, article: { attempt: articleAttempt, entry: articleEntry, draft: articleDraft, review: articleReview, gate: articleGate } }
}

describe('managed-site native publication fail-closed boundary', () => {
  it('never lets a reserved target fall through to the generic network publisher', async () => {
    const input = { target: nativeTarget(), publication: makePublication({ scheduleEntryId: 'entry-41' }), now: new Date('2026-10-06T00:00:00.000Z') }

    await expect(executeManagedSiteNativePublicationIfConfigured({ ...input, dependencies: { database: {} } })).resolves.toMatchObject({
      status: 'blocked',
      code: 'EXECUTOR_NOT_CONFIGURED',
    })
    await expect(executeManagedSiteNativePublicationIfConfigured({ ...input, target: nativeTarget({ contentRoot: 'ordinary-content', credentialReference: 'ordinary-hmac-reference' }), dependencies: { database: {} } })).resolves.toBeNull()

    const nativeCall = orchestratorSource.indexOf('executeManagedSiteNativePublicationIfConfigured')
    const nativeReturn = orchestratorSource.indexOf('if (native) return native', nativeCall)
    const genericCall = orchestratorSource.indexOf('return executeFirstPartyPublication', nativeReturn)
    expect(nativeCall).toBeGreaterThanOrEqual(0)
    expect(nativeReturn).toBeGreaterThan(nativeCall)
    expect(genericCall).toBeGreaterThan(nativeReturn)
  })

  it('blocks malformed reserved identity, unavailable database, and missing executor configuration', async () => {
    const publication = makePublication({ scheduleEntryId: 'entry-41' })
    const malformed = await executeManagedSiteNativePublicationIfConfigured({
      target: nativeTarget({ credentialReference: 'managed-site-cloudflare:not-a-project' }),
      publication,
      now: new Date('2026-10-06T00:00:00.000Z'),
      dependencies: { database: { transaction: async (run: (database: unknown) => unknown) => run({}) } },
    })
    expect(malformed).toMatchObject({ status: 'blocked' })
    expect(malformed).not.toBeNull()
    expect(nativeSource).toContain("if (!value) fail('Native Cloudflare publication is not configured.', 'EXECUTOR_NOT_CONFIGURED')")
  })

  it('turns competing whole-site work into a bounded retry instead of a second deployment', () => {
    expect(() => assertNoCompetingManagedSiteNativePublication(0, 0)).not.toThrow()
    for (const competitors of [[1, 0], [0, 1]] as const) {
      let result
      try {
        assertNoCompetingManagedSiteNativePublication(competitors[0], competitors[1])
      } catch (error) {
        result = classifyManagedSiteNativePublicationFailure(error)
      }
      expect(result).toEqual({
        status: 'retryable_failure',
        code: 'REMOTE_CONFLICT',
        reasons: ['Another whole-site publication is already in flight; retry after its durable receipt is finalized.'],
      })
    }
  })

  it('redacts arbitrary database and provider error details', () => {
    const secret = 'mysql://customer:password@private-db.example/internal'
    const blocked = classifyManagedSiteNativePublicationFailure(new Error(secret))
    const retryable = classifyManagedSiteNativePublicationFailure({ statusCode: 503, message: secret })
    expect(blocked).toEqual({ status: 'blocked', code: 'REQUEST_BLOCKED', reasons: ['Native managed-site publication failed closed.'] })
    expect(retryable).toEqual({ status: 'retryable_failure', code: 'REMOTE_SERVER_ERROR', reasons: ['Managed-site publication provider was unavailable.'], httpStatus: 503 })
    expect(JSON.stringify([blocked, retryable])).not.toContain(secret)
  })
})

describe('managed-site native publication authority', () => {
  it('requires the exact bound, effective payment and rejects refund or projection drift', () => {
    const fixture = paymentReceipts()
    expect(() => assertManagedSiteNativePaymentReceiptAuthority({ receipts: fixture.receipts, ...fixture.exact })).not.toThrow()

    const wrongProject = fixture.receipts.map(receipt => receipt.receiptType === 'checkout_succeeded' ? { ...receipt, projectId: projectId + 1 } : receipt)
    expect(() => assertManagedSiteNativePaymentReceiptAuthority({ receipts: wrongProject, ...fixture.exact })).toThrow(/exact paid release authority/u)

    const refunded = [...fixture.receipts, { ...fixture.exact, receiptFingerprint: 'c'.repeat(64), receiptType: 'payment_refunded', receiptStatus: 'verified', metadata: { effective: true } }]
    expect(() => assertManagedSiteNativePaymentReceiptAuthority({ receipts: refunded, ...fixture.exact })).toThrow(/refunded or disputed/u)
  })

  it('rechecks suspension and exact payment after transactional authority locks', () => {
    expect(nativeSource).toContain("project[0].status === 'suspended'")
    expect(nativeSource).toContain("project.status === 'suspended'")
    const recheck = nativeSource.indexOf('async function mutationAuthorityRecheck')
    const paymentCheck = nativeSource.indexOf('assertManagedSiteNativePaymentReceiptAuthority', recheck)
    const deploy = nativeSource.indexOf('await deploy(', paymentCheck)
    expect(recheck).toBeGreaterThanOrEqual(0)
    expect(paymentCheck).toBeGreaterThan(recheck)
    expect(deploy).toBeGreaterThan(paymentCheck)
  })

  it('uses the attempt entry for historical content and an exact append-only delivered event', () => {
    expect(managedSiteNativeArticleEntryId('current', 'entry-42', 900)).toBe(42)
    expect(managedSiteNativeArticleEntryId('historical', 'entry-999', 73)).toBe(73)
    expect(() => managedSiteNativeArticleEntryId('current', 'schedule-42', 73)).toThrow(/identity is malformed/u)
    expect(nativeSource).toContain("inArray(contentOperationEvents.eventType, ['publication_delivered', 'publication_route_delivered'])")
    expect(nativeSource).toContain("metadata.schemaVersion === 'content-publication-delivered-lineage-v1'")
    expect(nativeSource).toContain("if (matches.length !== 1) fail('Historical content publication has no exact append-only delivered lineage event.')")
    expect(nativeSource).toContain("if (mode === 'historical') lineage = await historicalArticleLineage(database, context, attempt)")
  })
})

describe('managed-site native publication integrated transaction', () => {
  it('rebuilds and deploys one edited page exactly once after every persisted authority check', async () => {
    const fixture = await integratedNativeFixture()
    const deploy = vi.fn(async (input: { assets: Array<{ path: string; content: string }>; canonicalDomain: string }) => {
      const homepages = input.assets.filter(asset => asset.path === 'index.html')
      expect(homepages).toHaveLength(1)
      expect(homepages[0]!.content).toContain('已由客戶完成編輯')
      expect(input.canonicalDomain).toBe(fixture.release.canonicalDomain)
      return { deploymentId: 'native-deployment-verified-001', deploymentUrl: `${fixture.canonicalOrigin}/` }
    })
    const assertPayment = vi.fn(async () => {})

    const result = await executeManagedSiteNativePublicationIfConfigured({
      target: fixture.target,
      publication: fixture.publication,
      pageWorkId: fixture.work.id,
      now: managedSiteFixedNow,
      dependencies: {
        database: fixture.database,
        now: () => managedSiteFixedNow.getTime(),
        vault: fixture.vault as any,
        configuration: { deploymentCredentialReference: 'envref:deploy', dnsTlsCredentialReference: 'envref:dns', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cloudflare', projectPrefix: 'ds' } },
        credentialResolver: async () => ({ ok: true, value: 'fixture-cloudflare-token' }),
        deploy: deploy as any,
        assertPayment,
      },
    })

    expect(result).toMatchObject({
      status: 'delivered',
      publicationId: fixture.publication.productionDeliverableId,
      contentHash: fixture.publication.contentHash,
      remoteRevision: expect.stringMatching(/^cloudflare-pages:native-deployment-verified-001:[a-f0-9]{24}$/u),
    })
    expect(assertPayment).toHaveBeenCalledTimes(1)
    expect(deploy).toHaveBeenCalledTimes(1)
  })

  it('does not call deploy when the exact bootstrap authority is missing', async () => {
    const fixture = await integratedNativeFixture({ bootstrapAuthority: false })
    const deploy = vi.fn()
    const result = await executeManagedSiteNativePublicationIfConfigured({
      target: fixture.target,
      publication: fixture.publication,
      pageWorkId: fixture.work.id,
      now: managedSiteFixedNow,
      dependencies: {
        database: fixture.database,
        now: () => managedSiteFixedNow.getTime(),
        vault: fixture.vault as any,
        configuration: { deploymentCredentialReference: 'envref:deploy', dnsTlsCredentialReference: 'envref:dns', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cloudflare', projectPrefix: 'ds' } },
        credentialResolver: async () => ({ ok: true, value: 'fixture-cloudflare-token' }),
        deploy: deploy as any,
        assertPayment: vi.fn(async () => {}),
      },
    })

    expect(result).toMatchObject({
      status: 'blocked',
      code: 'REQUEST_BLOCKED',
      reasons: ['Native publication immutable release/bootstrap lineage is missing.'],
    })
    expect(deploy).not.toHaveBeenCalled()
  })

  it('publishes one current human-approved article only after its latest review and risk gate remain authoritative', async () => {
    const fixture = await integratedNativeFixture({ articleAuthority: 'valid' })
    const articlePath = `zh-hant/articles/${fixture.publication.slug}/index.html`
    const deploy = vi.fn(async (input: { assets: Array<{ path: string; content: string }> }) => {
      const articles = input.assets.filter(asset => asset.path === articlePath)
      expect(articles).toHaveLength(1)
      expect(articles[0]!.content).toContain('客戶核准的最新文章')
      expect(articles[0]!.content).toContain('這是一篇經過付款、證據、人工審核與風險閘門確認的文章。')
      return { deploymentId: 'native-article-deployment-001', deploymentUrl: `${fixture.canonicalOrigin}/` }
    })
    const result = await executeManagedSiteNativePublicationIfConfigured({
      target: fixture.target,
      publication: fixture.publication,
      now: managedSiteFixedNow,
      dependencies: {
        database: fixture.database,
        now: () => managedSiteFixedNow.getTime(),
        vault: fixture.vault as any,
        configuration: { deploymentCredentialReference: 'envref:deploy', dnsTlsCredentialReference: 'envref:dns', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cloudflare', projectPrefix: 'ds' } },
        credentialResolver: async () => ({ ok: true, value: 'fixture-cloudflare-token' }),
        deploy: deploy as any,
        assertPayment: vi.fn(async () => {}),
      },
    })

    expect(result).toMatchObject({ status: 'delivered', publicationId: fixture.publication.productionDeliverableId, contentHash: fixture.publication.contentHash })
    expect(deploy).toHaveBeenCalledTimes(1)
  })

  it('retries without deploying when delivered content inventory changes after the rebuild snapshot', async () => {
    const fixture = await integratedNativeFixture({ articleAuthority: 'valid', inventoryChanged: true })
    const deploy = vi.fn()
    const result = await executeManagedSiteNativePublicationIfConfigured({
      target: fixture.target,
      publication: fixture.publication,
      now: managedSiteFixedNow,
      dependencies: {
        database: fixture.database,
        now: () => managedSiteFixedNow.getTime(),
        vault: fixture.vault as any,
        configuration: { deploymentCredentialReference: 'envref:deploy', dnsTlsCredentialReference: 'envref:dns', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cloudflare', projectPrefix: 'ds' } },
        credentialResolver: async () => ({ ok: true, value: 'fixture-cloudflare-token' }),
        deploy: deploy as any,
        assertPayment: vi.fn(async () => {}),
      },
    })

    expect(result).toEqual({
      status: 'retryable_failure',
      code: 'REMOTE_CONFLICT',
      reasons: ['Delivered content inventory changed during the whole-site rebuild; retry with a fresh snapshot.'],
    })
    expect(deploy).not.toHaveBeenCalled()
  })

  it.each([
    ['review_changed', 'Current native content publication owner approval changed before deployment.'],
    ['risk_changed', 'Current native content publication review/risk/evidence authority changed before deployment.'],
  ] as const)('blocks deploy when the latest %s supersedes the initially validated article authority', async (articleAuthority, reason) => {
    const fixture = await integratedNativeFixture({ articleAuthority })
    const deploy = vi.fn()
    const result = await executeManagedSiteNativePublicationIfConfigured({
      target: fixture.target,
      publication: fixture.publication,
      now: managedSiteFixedNow,
      dependencies: {
        database: fixture.database,
        now: () => managedSiteFixedNow.getTime(),
        vault: fixture.vault as any,
        configuration: { deploymentCredentialReference: 'envref:deploy', dnsTlsCredentialReference: 'envref:dns', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cloudflare', projectPrefix: 'ds' } },
        credentialResolver: async () => ({ ok: true, value: 'fixture-cloudflare-token' }),
        deploy: deploy as any,
        assertPayment: vi.fn(async () => {}),
      },
    })

    expect(result).toMatchObject({ status: 'blocked', code: 'REQUEST_BLOCKED', reasons: [reason] })
    expect(deploy).not.toHaveBeenCalled()
  })
})
