import { createHash } from 'node:crypto'
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm'
import { getDatabase } from '../../database'
import {
  contentOperationAutopilotPolicies,
  contentOperationCalendars,
  contentOperationClients,
  contentOperationEvents,
  contentOperationMachineAuthorizations,
  contentOperationPublicationAttempts,
  contentOperationPublicationTargets,
  contentOperationRuns,
  managedSiteConnectorReceipts,
  managedSiteGenerationCandidates,
  managedSiteMediaAssets,
  managedSiteMediaAssetVersions,
  managedSiteMediaObjects,
  managedSiteMediaVariants,
  managedSitePagePublicationWorks,
  managedSitePages,
  managedSiteProjects,
  managedSiteReleaseProjections,
  managedSiteStorageConnections,
  seoGeoContentDrafts,
  seoGeoContentJobs,
  seoGeoContentReviews,
  seoGeoContentRiskGates,
  contentOperationCalendarEntries,
} from '../../database/schema'
import { matchesCurrentV4ReservationAuthority, matchesPublishedV4DeliveredAuthority } from '../../content-operations/repository'
import { publicationPathFor } from '../../content-operations/publication-identity'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import { planFirstPartyPublication } from '../../first-party-publishing/command'
import { SIGNED_API_ENDPOINT_PATH } from '../../first-party-publishing/target-guard'
import type { ApprovedFirstPartyPublication, FirstPartyDecisionCode, FirstPartyExecutionResult, FirstPartyPublishTarget } from '../../first-party-publishing/types'
import { makeOrderingRepository } from '../ordering-repository'
import { makeManagedSiteRepository } from '../repository'
import { validateManagedSiteVaultBundle, parseManagedSiteVaultReference } from '../live-connectors/internal-broker/broker-fetch'
import { deployCloudflarePagesProduction, type CloudflarePagesOptions } from '../live-connectors/internal-broker/cloudflare-pages'
import { parseManagedSiteInternalBrokerConfiguration, type ManagedSiteInternalBrokerConfiguration } from '../live-connectors/internal-broker/config'
import type { ManagedSiteProductionProbe } from '../live-connectors/internal-broker/production-probe'
import { assertManagedSiteProductionPayment } from '../live-connectors/production-payment-authority'
import { makeManagedSiteLiveConnectorRepository } from '../live-connectors/repository'
import { resolveManagedSiteCredential } from '../live-connectors/provider-registry'
import type { ManagedSiteArtifactVault } from '../live-connectors/generation-service'
import type { ManagedSiteCredentialResolver } from '../live-connectors/types'
import { createS3ManagedSiteArtifactVault } from '../live-connectors/s3-vault'
import { isManagedSiteCloudflareTarget, MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT, MANAGED_SITE_CLOUDFLARE_TARGET_PREFIX } from './native-target'
import { managedSiteArticleAssetPath, managedSitePageAssetPath, renderManagedSiteNativeStaticAssets, type ManagedSiteNativeArticle } from './static-renderer'
import { buildManagedPageTransportEnvelope, parseManagedPageTransport } from './transport'
import type { CompiledPageArtifact } from './types'

const SHA256 = /^[a-f0-9]{64}$/u
const RESERVED_TARGET = new RegExp(`^${MANAGED_SITE_CLOUDFLARE_TARGET_PREFIX}:([1-9]\\d{0,14})$`, 'u')
const MAX_PAGES = 500
const MAX_PAGE_PUBLICATION_WORKS = 2_000
const MAX_ARTICLE_ATTEMPTS = 500
const MAX_MEDIA_REFERENCES = 1_000
const MAX_MEDIA_ROWS = 2_000
const TRUSTED_NATIVE_FAILURE = Symbol('trusted-managed-site-native-failure')

type NativeDependencies = {
  database?: any
  vault?: ManagedSiteArtifactVault
  configuration?: ManagedSiteInternalBrokerConfiguration | null
  credentialResolver?: ManagedSiteCredentialResolver
  deploy?: typeof deployCloudflarePagesProduction
  cloudflareFetch?: typeof fetch
  productionProbe?: ManagedSiteProductionProbe
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  assertPayment?: typeof assertManagedSiteProductionPayment
}

type NativeInput = {
  target: FirstPartyPublishTarget
  publication: ApprovedFirstPartyPublication
  now: Date
  pageWorkId?: number
  dependencies?: NativeDependencies
}

type NativeContext = {
  ownerUserId: number
  projectId: number
  targetRow: typeof contentOperationPublicationTargets.$inferSelect
  release: typeof managedSiteReleaseProjections.$inferSelect
  candidate: typeof managedSiteGenerationCandidates.$inferSelect
  bundle: ReturnType<typeof validateManagedSiteVaultBundle>
}

type MediaVariantRow = typeof managedSiteMediaVariants.$inferSelect
type MediaVersionRow = typeof managedSiteMediaAssetVersions.$inferSelect
type MediaObjectRow = typeof managedSiteMediaObjects.$inferSelect
type MediaAssetRow = typeof managedSiteMediaAssets.$inferSelect
type StorageConnectionRow = typeof managedSiteStorageConnections.$inferSelect
type NativePaymentReceipt = {
  receiptFingerprint: string
  releaseId: number | null
  projectId: number | null
  contentHash: string | null
  canonicalDomain: string | null
  receiptType: string
  receiptStatus: string
  metadata: unknown
}
type NativeArticleLineage = {
  entryId: number
  calendarId: number
  jobId: number
  draftId: number
  reviewId: number | null
  riskGateId: number
  productionDeliverableId: number
  strategyRecommendationId: number
  contentType: ManagedSiteNativeArticle['contentType']
  language: ManagedSiteNativeArticle['language']
  evidenceSnapshotHash: string
  contentHash: string
  publicationContentHash: string
  publicationAuthorityReference: string | null
  publicationSlug: string
  publicationPath: string
  status: string
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) }
function fail(message: string, reasonCode = 'REQUEST_BLOCKED'): never { throw Object.assign(new Error(message), { reasonCode, [TRUSTED_NATIVE_FAILURE]: true }) }
function ownerScopeKey(ownerUserId: number): string { return `owner-${sha256(String(ownerUserId)).slice(0, 32)}` }
function targetProjectId(target: FirstPartyPublishTarget): number | null { const match = RESERVED_TARGET.exec(target.credentialReference); const value = Number(match?.[1]); return Number.isSafeInteger(value) && value > 0 ? value : null }
function nativeCandidate(target: FirstPartyPublishTarget): boolean { return target.contentRoot === MANAGED_SITE_CLOUDFLARE_CONTENT_ROOT || target.credentialReference.startsWith(`${MANAGED_SITE_CLOUDFLARE_TARGET_PREFIX}:`) }

function articleInventoryFingerprint(rows: readonly (typeof contentOperationPublicationAttempts.$inferSelect)[]): string {
  return sha256(JSON.stringify(rows.map(row => ({ id: row.id, entryId: row.entryId, runId: row.runId, targetId: row.targetId, publicationId: row.publicationId, publicationSlug: row.publicationSlug, publicationPath: row.publicationPath, contentHash: row.contentHash, publicationContentHash: row.publicationContentHash, evidenceSnapshotHash: row.evidenceSnapshotHash, authorityReference: row.authorityReference, receiptFingerprint: row.receiptFingerprint, artifactFingerprint: row.artifactFingerprint, status: row.status }))))
}

function pageInventoryFingerprint(rows: readonly { pageId: string; route: string; publishedVersion: number; workId: number; artifactFingerprint: string }[]): string {
  return sha256(JSON.stringify(rows))
}

export function classifyManagedSiteNativePublicationFailure(error: unknown): FirstPartyExecutionResult {
  const value = error as { reasonCode?: unknown; code?: unknown; retryable?: unknown; statusCode?: unknown; message?: unknown; [TRUSTED_NATIVE_FAILURE]?: unknown }
  const trusted = value?.[TRUSTED_NATIVE_FAILURE] === true
  const status = Number(value?.statusCode || 0)
  if (trusted && value.reasonCode === 'REMOTE_CONFLICT') {
    const message = typeof value.message === 'string' ? value.message.slice(0, 500) : 'Another managed-site whole-site publication is in flight.'
    return { status: 'retryable_failure', code: 'REMOTE_CONFLICT', reasons: [message] }
  }
  if (value?.retryable === true || value?.code === 'RATE_LIMITED' || value?.code === 'UPSTREAM_FAILURE' || status === 429 || status >= 500) {
    const code: FirstPartyDecisionCode = value?.code === 'RATE_LIMITED' || status === 429 ? 'REMOTE_RATE_LIMITED' : status >= 500 || value?.code === 'UPSTREAM_FAILURE' ? 'REMOTE_SERVER_ERROR' : 'NETWORK_FAILURE'
    const message = code === 'REMOTE_RATE_LIMITED' ? 'Managed-site publication provider rate limited the request.' : code === 'REMOTE_SERVER_ERROR' ? 'Managed-site publication provider was unavailable.' : 'Managed-site publication transport failed before a verified receipt.'
    return { status: 'retryable_failure', code, reasons: [message], ...(status >= 400 ? { httpStatus: status } : {}) }
  }
  const allowed = new Set<FirstPartyDecisionCode>(['INVALID_INPUT', 'OWNER_SCOPE_MISMATCH', 'CREDENTIAL_MISSING', 'EXECUTOR_NOT_CONFIGURED', 'REQUEST_BLOCKED', 'RESPONSE_INVALID', 'REMOTE_CONFLICT', 'TARGET_NOT_ACTIVE'])
  const reasonCode = trusted && typeof value?.reasonCode === 'string' && allowed.has(value.reasonCode as FirstPartyDecisionCode) ? value.reasonCode as FirstPartyDecisionCode : status === 401 || status === 403 ? 'REMOTE_UNAUTHORIZED' : status === 409 ? 'REMOTE_CONFLICT' : 'REQUEST_BLOCKED'
  const message = trusted && typeof value?.message === 'string' ? value.message.slice(0, 500) : reasonCode === 'REMOTE_UNAUTHORIZED' ? 'Managed-site publication provider rejected its configured authority.' : reasonCode === 'REMOTE_CONFLICT' ? 'Managed-site publication provider reported a conflicting production state.' : 'Native managed-site publication failed closed.'
  return { status: 'blocked', code: reasonCode, reasons: [message] }
}

function configuration(dependencies: NativeDependencies): ManagedSiteInternalBrokerConfiguration {
  const value = dependencies.configuration === undefined ? parseManagedSiteInternalBrokerConfiguration() : dependencies.configuration
  if (!value) fail('Native Cloudflare publication is not configured.', 'EXECUTOR_NOT_CONFIGURED')
  return value
}

export function assertManagedSiteNativePaymentReceiptAuthority(input: {
  receipts: readonly NativePaymentReceipt[]
  releaseId: number
  projectId: number
  contentHash: string
  canonicalDomain: string
}): void {
  if (input.receipts.length > 500) fail('Native publication payment receipt history exceeds the bounded authority limit.')
  if (input.receipts.some(receipt => receipt.receiptStatus === 'verified' && ['payment_refunded', 'payment_disputed'].includes(receipt.receiptType) && plain(receipt.metadata) && receipt.metadata.effective === true)) fail('Native publication payment was refunded or disputed before deployment.')
  const exact = (receipt: NativePaymentReceipt) => receipt.releaseId === input.releaseId && receipt.projectId === input.projectId && receipt.contentHash === input.contentHash && receipt.canonicalDomain === input.canonicalDomain
  const bound = input.receipts.find(receipt => exact(receipt) && receipt.receiptType === 'release_payment_bound' && receipt.receiptStatus === 'verified')
  const boundMetadata = plain(bound?.metadata) ? bound!.metadata : {}
  const paymentFingerprint = boundMetadata.paymentReceiptFingerprint || boundMetadata.checkoutReceiptFingerprint
  const payment = input.receipts.find(receipt => receipt.receiptFingerprint === paymentFingerprint && exact(receipt) && receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified')
  if (!payment || !plain(payment.metadata) || payment.metadata.effective !== true) fail('Native publication exact paid release authority is no longer valid.')
}

async function lockedActiveRelease(database: any, ownerUserId: number, projectId: number) {
  const query = database.select().from(managedSiteReleaseProjections).where(and(eq(managedSiteReleaseProjections.ownerUserId, ownerUserId), eq(managedSiteReleaseProjections.projectId, projectId), inArray(managedSiteReleaseProjections.status, ['live_verified', 'geo_active']))).orderBy(desc(managedSiteReleaseProjections.id)).limit(2)
  if (typeof query.for !== 'function') fail('Native publication requires transactional release locking.')
  const rows = await query.for('update')
  if (rows.length !== 1) fail('Native publication requires one exact active managed-site release.')
  return rows[0] as typeof managedSiteReleaseProjections.$inferSelect
}

async function loadAuthority(database: any, input: NativeInput): Promise<NativeContext> {
  const projectId = targetProjectId(input.target)
  if (!projectId) fail('Reserved native publication target identity is malformed.', 'INVALID_INPUT')
  const targets = await database.select().from(contentOperationPublicationTargets).where(eq(contentOperationPublicationTargets.targetId, input.target.targetId)).limit(2)
  if (targets.length !== 1) fail('Native publication target row is missing or ambiguous.')
  const targetRow = targets[0]!
  const ownerUserId = targetRow.ownerUserId
  if (input.target.ownerScopeKey !== ownerScopeKey(ownerUserId)) fail('Native publication owner scope is mismatched.', 'OWNER_SCOPE_MISMATCH')
  const release = await lockedActiveRelease(database, ownerUserId, projectId)
  const canonicalOrigin = `https://${release.canonicalDomain}`
  if (!isManagedSiteCloudflareTarget({ target: targetRow, ownerUserId, clientId: targetRow.clientId, projectId, canonicalOrigin, endpointPath: SIGNED_API_ENDPOINT_PATH })) fail('Native publication target authority is stale or incompatible.', 'TARGET_NOT_ACTIVE')
  const projected = input.target
  if (projected.targetId !== targetRow.targetId || projected.framework !== targetRow.framework || projected.transport !== targetRow.transport || projected.targetOrigin !== targetRow.targetOrigin || projected.contentRoot !== targetRow.contentRoot || projected.endpointPath !== targetRow.endpointPath || projected.credentialReference !== targetRow.credentialReference || projected.status !== targetRow.status || projected.executionEnabled !== targetRow.executionEnabled) fail('Native publication target projection drifted.')
  const [project, client] = await Promise.all([
    database.select().from(managedSiteProjects).where(and(eq(managedSiteProjects.id, projectId), eq(managedSiteProjects.ownerUserId, ownerUserId))).limit(1),
    database.select().from(contentOperationClients).where(and(eq(contentOperationClients.id, targetRow.clientId), eq(contentOperationClients.ownerUserId, ownerUserId))).limit(1),
  ])
  if (!project[0] || project[0].status === 'suspended' || project[0].contentOperationClientId !== targetRow.clientId || !client[0] || client[0].status !== 'active' || client[0].canonicalSiteOrigin !== canonicalOrigin || client[0].framework !== 'astro' || client[0].publicationTransport !== 'first_party_signed_api') fail('Native publication project/client authority is stale.')
  if (release.releaseKind !== 'generated_site' || !release.generationCandidateId || !release.activeDeploymentReceiptFingerprint || release.canonicalDomain !== new URL(targetRow.targetOrigin).hostname) fail('Native publication release authority is incomplete.')
  const [candidateRows, productionRows, bootstrapRows] = await Promise.all([
    database.select().from(managedSiteGenerationCandidates).where(and(eq(managedSiteGenerationCandidates.id, release.generationCandidateId), eq(managedSiteGenerationCandidates.ownerUserId, ownerUserId), eq(managedSiteGenerationCandidates.projectId, projectId))).limit(2),
    database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.ownerUserId, ownerUserId), eq(managedSiteConnectorReceipts.receiptFingerprint, release.activeDeploymentReceiptFingerprint))).limit(2),
    database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.ownerUserId, ownerUserId), eq(managedSiteConnectorReceipts.projectId, projectId), eq(managedSiteConnectorReceipts.releaseId, release.id), eq(managedSiteConnectorReceipts.receiptType, 'customer_workspace_bootstrapped'), eq(managedSiteConnectorReceipts.receiptStatus, 'verified'), eq(managedSiteConnectorReceipts.externalReference, targetRow.targetId))).orderBy(desc(managedSiteConnectorReceipts.id)).limit(2),
  ])
  if (candidateRows.length !== 1 || productionRows.length !== 1 || bootstrapRows.length < 1) fail('Native publication immutable release/bootstrap lineage is missing.')
  const candidate = candidateRows[0]!
  const production = productionRows[0]!
  const bootstrap = bootstrapRows[0]!
  if (candidate.sourceVersionId !== release.versionId || candidate.contentHash !== release.contentHash || production.releaseId !== release.id || production.projectId !== projectId || production.receiptType !== 'production_deployment_verified' || production.receiptStatus !== 'verified' || production.contentHash !== release.contentHash || production.canonicalDomain !== release.canonicalDomain) fail('Native publication production receipt or candidate lineage is stale.')
  const metadata = plain(bootstrap.metadata) ? bootstrap.metadata : {}
  if (metadata.productionReceiptFingerprint !== production.receiptFingerprint || metadata.clientId !== targetRow.clientId || metadata.targetRowId !== targetRow.id || metadata.targetId !== targetRow.targetId || metadata.insertOnly !== true || bootstrap.contentHash !== release.contentHash || bootstrap.canonicalDomain !== release.canonicalDomain) fail('Native publication bootstrap receipt is mismatched.')
  const assertPayment = input.dependencies?.assertPayment || assertManagedSiteProductionPayment
  await assertPayment(ownerUserId, release, makeManagedSiteLiveConnectorRepository(database), makeOrderingRepository(database), makeManagedSiteRepository(database))
  const vaultIdentity = parseManagedSiteVaultReference(candidate.vaultReference)
  if (vaultIdentity.ownerUserId !== ownerUserId || vaultIdentity.projectId !== projectId || vaultIdentity.requestFingerprint !== candidate.requestFingerprint) fail('Native publication vault reference is mismatched.')
  const vault = input.dependencies?.vault || createS3ManagedSiteArtifactVault()
  const stored = await vault.lookupImmutableCandidate(vaultIdentity)
  if (!stored || stored.vaultReference !== candidate.vaultReference) fail('Native publication immutable vault object is unavailable.')
  const bundle = validateManagedSiteVaultBundle(stored.bundle, { ...vaultIdentity, contentHash: release.contentHash })
  return { ownerUserId, projectId, targetRow, release, candidate, bundle }
}

async function mutationAuthorityRecheck(database: any, context: NativeContext, input: NativeInput, currentAttemptId: number | null, sourceSnapshot: { articleInventoryFingerprint: string; pageInventoryFingerprint: string }): Promise<void> {
  const lock = async (query: any) => {
    if (typeof query?.for !== 'function') fail('Native publication requires transactional authority locking.')
    return query.for('update')
  }
  const currentIsArticle = ['article', 'faq', 'service_page'].includes(input.publication.contentType)
  const authorityNowMilliseconds = (input.dependencies?.now || Date.now)()
  if (!Number.isFinite(authorityNowMilliseconds)) fail('Native publication authority clock is invalid.')
  const authorityNow = new Date(authorityNowMilliseconds)
  let expectedAttempt: typeof contentOperationPublicationAttempts.$inferSelect | null = null
  let expectedEntry: typeof contentOperationCalendarEntries.$inferSelect | null = null
  let lockedAuthorization: typeof contentOperationMachineAuthorizations.$inferSelect | null = null
  let lockedPolicy: typeof contentOperationAutopilotPolicies.$inferSelect | null = null
  if (currentIsArticle) {
    if (!currentAttemptId) fail('Current native content publication reservation identity is missing.')
    const entryId = managedSiteNativeArticleEntryId('current', input.publication.scheduleEntryId, 0)
    const attemptRows = await database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.id, currentAttemptId), eq(contentOperationPublicationAttempts.ownerUserId, context.ownerUserId), eq(contentOperationPublicationAttempts.clientId, context.targetRow.clientId), eq(contentOperationPublicationAttempts.targetId, context.targetRow.id))).limit(2)
    const entryRows = await database.select().from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.id, entryId), eq(contentOperationCalendarEntries.ownerUserId, context.ownerUserId))).limit(2)
    if (attemptRows.length !== 1 || entryRows.length !== 1 || !entryRows[0]!.jobId || !entryRows[0]!.draftId) fail('Current native content publication mutation lineage is missing or ambiguous.')
    expectedAttempt = attemptRows[0] as typeof contentOperationPublicationAttempts.$inferSelect
    expectedEntry = entryRows[0] as typeof contentOperationCalendarEntries.$inferSelect
    const jobs = await lock(database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.id, expectedEntry.jobId!), eq(seoGeoContentJobs.ownerUserId, context.ownerUserId))).limit(2))
    if (jobs.length !== 1) fail('Current native content publication job authority disappeared before deployment.')
    const runs = await lock(database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.id, expectedAttempt.runId), eq(contentOperationRuns.ownerUserId, context.ownerUserId), eq(contentOperationRuns.entryId, expectedEntry.id), eq(contentOperationRuns.stage, 'publication'))).limit(2))
    const run = runs[0] as typeof contentOperationRuns.$inferSelect | undefined
    if (runs.length !== 1 || !run || run.state !== 'processing' || !run.leaseOwner || !run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= authorityNowMilliseconds + 31_000) fail('Current native content publication execution lease changed or is too short for a bounded deployment.', 'REMOTE_CONFLICT')
    const authorityReference = expectedAttempt.authorityReference
    if (authorityReference && SHA256.test(authorityReference)) {
      const authorizations = await lock(database.select().from(contentOperationMachineAuthorizations).where(and(eq(contentOperationMachineAuthorizations.ownerUserId, context.ownerUserId), eq(contentOperationMachineAuthorizations.authorizationFingerprint, authorityReference))).limit(2))
      const policies = await lock(database.select().from(contentOperationAutopilotPolicies).where(and(eq(contentOperationAutopilotPolicies.ownerUserId, context.ownerUserId), eq(contentOperationAutopilotPolicies.clientId, context.targetRow.clientId), eq(contentOperationAutopilotPolicies.publicationTargetId, context.targetRow.id))).limit(2))
      if (authorizations.length !== 1 || policies.length !== 1) fail('Current native content publication machine authority disappeared before deployment.')
      lockedAuthorization = authorizations[0] as typeof contentOperationMachineAuthorizations.$inferSelect
      lockedPolicy = policies[0] as typeof contentOperationAutopilotPolicies.$inferSelect
    } else if (authorityReference) {
      const policyId = /^ref-autopilot-([A-Za-z0-9._:-]+)$/u.exec(authorityReference)?.[1]
      if (!policyId) fail('Current native content publication machine authority reference is malformed.')
      const policies = await lock(database.select().from(contentOperationAutopilotPolicies).where(and(eq(contentOperationAutopilotPolicies.ownerUserId, context.ownerUserId), eq(contentOperationAutopilotPolicies.clientId, context.targetRow.clientId), eq(contentOperationAutopilotPolicies.publicationTargetId, context.targetRow.id), eq(contentOperationAutopilotPolicies.policyId, policyId))).limit(2))
      if (policies.length !== 1) fail('Current native content publication policy authority disappeared before deployment.')
      lockedPolicy = policies[0] as typeof contentOperationAutopilotPolicies.$inferSelect
    }
  }
  // One transaction owns one SQL connection. Acquire locks in a stable sequence so
  // drivers never receive concurrent queries on that connection and every native
  // publisher observes the same release -> target -> project -> client lock order.
  const releaseRows = await lock(database.select().from(managedSiteReleaseProjections).where(and(eq(managedSiteReleaseProjections.id, context.release.id), eq(managedSiteReleaseProjections.ownerUserId, context.ownerUserId), eq(managedSiteReleaseProjections.projectId, context.projectId))).limit(2))
  const targetRows = await lock(database.select().from(contentOperationPublicationTargets).where(and(eq(contentOperationPublicationTargets.id, context.targetRow.id), eq(contentOperationPublicationTargets.ownerUserId, context.ownerUserId), eq(contentOperationPublicationTargets.clientId, context.targetRow.clientId))).limit(2))
  const projectRows = await lock(database.select().from(managedSiteProjects).where(and(eq(managedSiteProjects.id, context.projectId), eq(managedSiteProjects.ownerUserId, context.ownerUserId))).limit(2))
  const clientRows = await lock(database.select().from(contentOperationClients).where(and(eq(contentOperationClients.id, context.targetRow.clientId), eq(contentOperationClients.ownerUserId, context.ownerUserId))).limit(2))
  const release = releaseRows[0] as typeof managedSiteReleaseProjections.$inferSelect | undefined
  const target = targetRows[0] as typeof contentOperationPublicationTargets.$inferSelect | undefined
  const project = projectRows[0] as typeof managedSiteProjects.$inferSelect | undefined
  const client = clientRows[0] as typeof contentOperationClients.$inferSelect | undefined
  if (releaseRows.length !== 1 || targetRows.length !== 1 || projectRows.length !== 1 || clientRows.length !== 1 || !release || !target || !project || !client) fail('Native publication mutation authority disappeared before deployment.')
  if (release.projectionFingerprint !== context.release.projectionFingerprint || release.activeDeploymentReceiptFingerprint !== context.release.activeDeploymentReceiptFingerprint || !['live_verified', 'geo_active'].includes(release.status) || target.configurationFingerprint !== context.targetRow.configurationFingerprint || target.updatedAt.getTime() !== context.targetRow.updatedAt.getTime() || target.status !== 'active' || target.executionEnabled !== true || project.status === 'suspended' || project.contentOperationClientId !== target.clientId || client.status !== 'active' || client.canonicalSiteOrigin !== `https://${release.canonicalDomain}`) fail('Native publication owner/release/target authority changed before deployment.')
  if (!release.draftOrderId) fail('Native publication payment authority is incomplete.')
  const receipts = await lock(database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.ownerUserId, context.ownerUserId), eq(managedSiteConnectorReceipts.draftOrderId, release.draftOrderId))).orderBy(desc(managedSiteConnectorReceipts.id)).limit(501)) as Array<typeof managedSiteConnectorReceipts.$inferSelect>
  assertManagedSiteNativePaymentReceiptAuthority({ receipts, releaseId: release.id, projectId: context.projectId, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain })
  await assertManagedSiteProductionPayment(context.ownerUserId, release, makeManagedSiteLiveConnectorRepository(database), makeOrderingRepository(database), makeManagedSiteRepository(database))
  // A native deployment replaces the whole static site. Lock competing work and
  // compare the exact source inventory after the target lock so a publication
  // finalized between the first snapshot and this mutation gate cannot be lost.
  const competingAttempts = await lock(database.select({ id: contentOperationPublicationAttempts.id }).from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, context.ownerUserId), eq(contentOperationPublicationAttempts.clientId, context.targetRow.clientId), eq(contentOperationPublicationAttempts.targetId, context.targetRow.id), eq(contentOperationPublicationAttempts.status, 'planned'), currentAttemptId ? ne(contentOperationPublicationAttempts.id, currentAttemptId) : undefined)).limit(1))
  const competingPageWorks = await lock(database.select({ id: managedSitePagePublicationWorks.id }).from(managedSitePagePublicationWorks).where(and(eq(managedSitePagePublicationWorks.ownerUserId, context.ownerUserId), eq(managedSitePagePublicationWorks.projectId, context.projectId), eq(managedSitePagePublicationWorks.publicationTargetId, context.targetRow.id), eq(managedSitePagePublicationWorks.status, 'leased'), input.pageWorkId ? ne(managedSitePagePublicationWorks.id, input.pageWorkId) : undefined)).limit(1))
  assertNoCompetingManagedSiteNativePublication(competingPageWorks.length, competingAttempts.length)
  if (input.pageWorkId) {
    const currentPageWorks = await lock(database.select().from(managedSitePagePublicationWorks).where(and(eq(managedSitePagePublicationWorks.id, input.pageWorkId), eq(managedSitePagePublicationWorks.ownerUserId, context.ownerUserId), eq(managedSitePagePublicationWorks.projectId, context.projectId), eq(managedSitePagePublicationWorks.publicationTargetId, context.targetRow.id), eq(managedSitePagePublicationWorks.releaseId, context.release.id))).limit(2))
    const currentPageWork = currentPageWorks[0] as typeof managedSitePagePublicationWorks.$inferSelect | undefined
    if (currentPageWorks.length !== 1 || !currentPageWork || currentPageWork.status !== 'leased' || !currentPageWork.leaseOwner || !currentPageWork.leaseUntil || currentPageWork.leaseUntil.getTime() <= authorityNowMilliseconds + 31_000) fail('Current page publication lease changed or is too short for a bounded deployment.', 'REMOTE_CONFLICT')
  }
  const deliveredAttempts = await lock(database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, context.ownerUserId), eq(contentOperationPublicationAttempts.clientId, context.targetRow.clientId), eq(contentOperationPublicationAttempts.targetId, context.targetRow.id), eq(contentOperationPublicationAttempts.status, 'delivered'))).orderBy(desc(contentOperationPublicationAttempts.id)).limit(MAX_ARTICLE_ATTEMPTS + 1)) as Array<typeof contentOperationPublicationAttempts.$inferSelect>
  if (deliveredAttempts.length > MAX_ARTICLE_ATTEMPTS) fail('Delivered content history exceeds the bounded native rebuild limit.')
  if (articleInventoryFingerprint(deliveredAttempts) !== sourceSnapshot.articleInventoryFingerprint) fail('Delivered content inventory changed during the whole-site rebuild; retry with a fresh snapshot.', 'REMOTE_CONFLICT')
  const successfulWorks = await lock(database.select().from(managedSitePagePublicationWorks).where(and(eq(managedSitePagePublicationWorks.ownerUserId, context.ownerUserId), eq(managedSitePagePublicationWorks.projectId, context.projectId), eq(managedSitePagePublicationWorks.publicationTargetId, context.targetRow.id), eq(managedSitePagePublicationWorks.releaseId, context.release.id), eq(managedSitePagePublicationWorks.status, 'succeeded'))).orderBy(desc(managedSitePagePublicationWorks.id)).limit(MAX_PAGE_PUBLICATION_WORKS + 1)) as Array<typeof managedSitePagePublicationWorks.$inferSelect>
  if (successfulWorks.length > MAX_PAGE_PUBLICATION_WORKS) fail('Published page work history exceeds the bounded native rebuild limit.')
  const publishedPages = await lock(database.select().from(managedSitePages).where(and(eq(managedSitePages.ownerUserId, context.ownerUserId), eq(managedSitePages.projectId, context.projectId), gt(managedSitePages.publishedVersion, 0))).orderBy(managedSitePages.route, managedSitePages.pageId).limit(MAX_PAGES + 1)) as Array<typeof managedSitePages.$inferSelect>
  if (publishedPages.length > MAX_PAGES) fail('Published page inventory exceeds the bounded native rebuild limit.')
  const pageInventory = publishedPages.map(page => {
    const work = successfulWorks.find(candidate => candidate.pageId === page.pageId && candidate.pageVersion === page.publishedVersion)
    if (!work) fail('Published page inventory changed without an exact successful artifact.', 'REMOTE_CONFLICT')
    return { pageId: page.pageId, route: page.route, publishedVersion: page.publishedVersion, workId: work.id, artifactFingerprint: work.artifactFingerprint }
  })
  if (pageInventoryFingerprint(pageInventory) !== sourceSnapshot.pageInventoryFingerprint) fail('Published page inventory changed during the whole-site rebuild; retry with a fresh snapshot.', 'REMOTE_CONFLICT')
  if (currentIsArticle) {
    if (!expectedAttempt || !expectedEntry || !expectedEntry.jobId || !expectedEntry.draftId) fail('Current native content publication mutation lineage is incomplete.')
    const attemptRows = await lock(database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.id, expectedAttempt.id), eq(contentOperationPublicationAttempts.ownerUserId, context.ownerUserId), eq(contentOperationPublicationAttempts.clientId, context.targetRow.clientId), eq(contentOperationPublicationAttempts.targetId, context.targetRow.id))).limit(2))
    const entryRows = await lock(database.select().from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.id, expectedEntry.id), eq(contentOperationCalendarEntries.ownerUserId, context.ownerUserId))).limit(2))
    const draftRows = await lock(database.select().from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.id, expectedEntry.draftId), eq(seoGeoContentDrafts.jobId, expectedEntry.jobId))).limit(2))
    const reviewRows = await lock(database.select().from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.jobId, expectedEntry.jobId), eq(seoGeoContentReviews.draftId, expectedEntry.draftId), eq(seoGeoContentReviews.reviewerUserId, context.ownerUserId), eq(seoGeoContentReviews.evidenceSnapshotHash, input.publication.evidenceSnapshotHash))).orderBy(desc(seoGeoContentReviews.id)).limit(1))
    const gateRows = await lock(database.select().from(seoGeoContentRiskGates).where(and(eq(seoGeoContentRiskGates.draftId, expectedEntry.draftId), eq(seoGeoContentRiskGates.evidenceSnapshotHash, input.publication.evidenceSnapshotHash))).orderBy(desc(seoGeoContentRiskGates.id)).limit(1))
    const attempt = attemptRows[0] as typeof contentOperationPublicationAttempts.$inferSelect | undefined
    const entry = entryRows[0] as typeof contentOperationCalendarEntries.$inferSelect | undefined
    const draft = draftRows[0] as typeof seoGeoContentDrafts.$inferSelect | undefined
    const latestReview = reviewRows[0] as typeof seoGeoContentReviews.$inferSelect | undefined
    const latestGate = gateRows[0] as typeof seoGeoContentRiskGates.$inferSelect | undefined
    if (attemptRows.length !== 1 || entryRows.length !== 1 || draftRows.length !== 1 || !attempt || !entry || !draft || !latestGate) fail('Current native content publication authority disappeared before deployment.')
    const bodyHash = sha256(draft.body)
    if (attempt.status !== 'planned' || attempt.entryId !== entry.id || attempt.runId !== expectedAttempt.runId || attempt.idempotencyKey !== expectedAttempt.idempotencyKey || attempt.publicationId !== expectedAttempt.publicationId || attempt.publicationSlug !== expectedAttempt.publicationSlug || attempt.publicationPath !== expectedAttempt.publicationPath || attempt.contentHash !== draft.contentHash || attempt.publicationContentHash !== bodyHash || attempt.evidenceSnapshotHash !== input.publication.evidenceSnapshotHash || entry.jobId !== expectedEntry.jobId || entry.draftId !== expectedEntry.draftId || entry.evidenceSnapshotHash !== input.publication.evidenceSnapshotHash || entry.contentHash !== draft.contentHash || entry.publicationContentHash !== bodyHash || entry.publicationTargetId !== context.targetRow.id || entry.publicationSlug !== attempt.publicationSlug || entry.publicationPath !== attempt.publicationPath || draft.safetyStatus !== 'passed' || !plain(draft.provenance) || draft.provenance.stage !== 'optimized' || bodyHash !== input.publication.contentHash || input.publication.jobId !== `job-${entry.jobId}` || input.publication.draftId !== `draft-${entry.draftId}` || input.publication.draftVersion !== draft.version || latestGate.status !== 'passed') fail('Current native content publication review/risk/evidence authority changed before deployment.')
    const authorityReference = attempt.authorityReference
    if (!authorityReference) {
      if (!latestReview || latestReview.id !== entry.reviewId || latestReview.decision !== 'approved_for_delivery' || input.publication.reviewId !== `review-${latestReview.id}`) fail('Current native content publication owner approval changed before deployment.')
    } else {
      if (input.publication.reviewId !== authorityReference || latestReview && latestReview.decision !== 'approved_for_delivery') fail('Current native content publication machine approval was superseded before deployment.')
      if (SHA256.test(authorityReference)) {
        if (!matchesCurrentV4ReservationAuthority(lockedAuthorization, lockedPolicy, target, { ownerUserId: context.ownerUserId, clientId: context.targetRow.clientId, entryId: entry.id, jobId: entry.jobId, draftId: entry.draftId, targetId: context.targetRow.id, contentHash: draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, startedAt: authorityNow, authorityReference })) fail('Current native content publication V4 authority changed or expired before deployment.')
      } else if (!lockedPolicy || lockedPolicy.policyVersion !== 'governed-autopilot-policy-v3' || lockedPolicy.status !== 'enabled' || lockedPolicy.revokedAt || lockedPolicy.expiresAt.getTime() <= authorityNow.getTime() || lockedPolicy.authorizedByOwnerUserId !== context.ownerUserId || lockedPolicy.requirePassedRiskGate !== true) fail('Current native content publication policy authority changed or expired before deployment.')
    }
  }
}

async function assertExclusivePublication(database: any, context: NativeContext, input: NativeInput, currentAttemptId: number | null): Promise<void> {
  let currentPageWorkId: number | null = null
  if (input.pageWorkId !== undefined) {
    const rows = await database.select().from(managedSitePagePublicationWorks).where(and(eq(managedSitePagePublicationWorks.id, input.pageWorkId), eq(managedSitePagePublicationWorks.ownerUserId, context.ownerUserId), eq(managedSitePagePublicationWorks.projectId, context.projectId), eq(managedSitePagePublicationWorks.publicationTargetId, context.targetRow.id), eq(managedSitePagePublicationWorks.releaseId, context.release.id), eq(managedSitePagePublicationWorks.status, 'leased'))).limit(2)
    if (rows.length !== 1) fail('Current page publication lease is no longer authoritative.')
    currentPageWorkId = rows[0]!.id
  }
  const pageCompetitors = await database.select({ id: managedSitePagePublicationWorks.id }).from(managedSitePagePublicationWorks).where(and(eq(managedSitePagePublicationWorks.ownerUserId, context.ownerUserId), eq(managedSitePagePublicationWorks.projectId, context.projectId), eq(managedSitePagePublicationWorks.publicationTargetId, context.targetRow.id), eq(managedSitePagePublicationWorks.status, 'leased'), currentPageWorkId ? ne(managedSitePagePublicationWorks.id, currentPageWorkId) : undefined)).limit(1)
  const articleCompetitors = await database.select({ id: contentOperationPublicationAttempts.id }).from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, context.ownerUserId), eq(contentOperationPublicationAttempts.clientId, context.targetRow.clientId), eq(contentOperationPublicationAttempts.targetId, context.targetRow.id), eq(contentOperationPublicationAttempts.status, 'planned'), currentAttemptId ? ne(contentOperationPublicationAttempts.id, currentAttemptId) : undefined)).limit(1)
  assertNoCompetingManagedSiteNativePublication(pageCompetitors.length, articleCompetitors.length)
}

export function assertNoCompetingManagedSiteNativePublication(pageCompetitors: number, articleCompetitors: number): void {
  if (![pageCompetitors, articleCompetitors].every(value => Number.isSafeInteger(value) && value >= 0)) fail('Native publication competitor counts are invalid.', 'INVALID_INPUT')
  if (pageCompetitors || articleCompetitors) fail('Another whole-site publication is already in flight; retry after its durable receipt is finalized.', 'REMOTE_CONFLICT')
}

function articleFromPublication(publication: ApprovedFirstPartyPublication): ManagedSiteNativeArticle {
  if (!['article', 'faq', 'service_page'].includes(publication.contentType) || !['en', 'zh-hant'].includes(publication.language)) fail('Native article content type or language is unsupported.', 'INVALID_INPUT')
  return { publicationId: publication.productionDeliverableId, slug: publication.slug, title: publication.title, body: publication.body, contentHash: publication.contentHash, contentType: publication.contentType as ManagedSiteNativeArticle['contentType'], language: publication.language as ManagedSiteNativeArticle['language'], evidenceSnapshotHash: publication.evidenceSnapshotHash }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label} is malformed.`)
  return Number(value)
}

async function historicalArticleLineage(database: any, context: NativeContext, attempt: typeof contentOperationPublicationAttempts.$inferSelect): Promise<NativeArticleLineage> {
  const events = await database.select().from(contentOperationEvents).where(and(
    eq(contentOperationEvents.ownerUserId, context.ownerUserId),
    eq(contentOperationEvents.clientId, context.targetRow.clientId),
    eq(contentOperationEvents.entryId, attempt.entryId),
    eq(contentOperationEvents.runId, attempt.runId),
    inArray(contentOperationEvents.eventType, ['publication_delivered', 'publication_route_delivered']),
  )).orderBy(desc(contentOperationEvents.id)).limit(101)
  if (events.length > 100) fail('Historical content publication delivered lineage exceeds the bounded lookup limit.')
  const matches = events.filter((event: typeof contentOperationEvents.$inferSelect) => {
    const metadata = plain(event.metadata) ? event.metadata : {}
    return metadata.schemaVersion === 'content-publication-delivered-lineage-v1'
      && metadata.attemptId === attempt.id
      && metadata.targetId === attempt.targetId
      && metadata.publicationId === attempt.publicationId
      && metadata.publicationSlug === attempt.publicationSlug
      && metadata.publicationPath === attempt.publicationPath
      && event.deliverableId === metadata.productionDeliverableId
      && event.draftId === metadata.draftId
      && event.contentHash === (attempt.publicationContentHash || attempt.contentHash)
      && event.evidenceSnapshotHash === attempt.evidenceSnapshotHash
      && event.authorityReference === (attempt.authorityReference || null)
  })
  if (matches.length !== 1) fail('Historical content publication has no exact append-only delivered lineage event.')
  const event = matches[0]!
  const metadata = event.metadata as Record<string, unknown>
  const contentType = metadata.contentType
  const language = metadata.language
  if (!['article', 'faq', 'service_page'].includes(String(contentType)) || !['en', 'zh-hant'].includes(String(language)) || typeof event.contentHash !== 'string' || !SHA256.test(event.contentHash) || typeof event.evidenceSnapshotHash !== 'string' || !SHA256.test(event.evidenceSnapshotHash)) fail('Historical content publication delivered lineage is malformed.')
  return {
    entryId: attempt.entryId,
    calendarId: positiveInteger(event.calendarId, 'Historical publication calendar identity'),
    jobId: positiveInteger(metadata.jobId, 'Historical publication job identity'),
    draftId: positiveInteger(event.draftId, 'Historical publication draft identity'),
    reviewId: metadata.reviewId === null ? null : positiveInteger(metadata.reviewId, 'Historical publication review identity'),
    riskGateId: positiveInteger(metadata.riskGateId, 'Historical publication risk gate identity'),
    productionDeliverableId: positiveInteger(metadata.productionDeliverableId, 'Historical publication deliverable identity'),
    strategyRecommendationId: positiveInteger(metadata.strategyRecommendationId, 'Historical publication strategy identity'),
    contentType: contentType as NativeArticleLineage['contentType'], language: language as NativeArticleLineage['language'],
    evidenceSnapshotHash: event.evidenceSnapshotHash, contentHash: attempt.contentHash,
    publicationContentHash: attempt.publicationContentHash || attempt.contentHash,
    publicationAuthorityReference: event.authorityReference || null,
    publicationSlug: attempt.publicationSlug, publicationPath: attempt.publicationPath, status: 'delivered',
  }
}

async function validateArticleLineage(database: any, context: NativeContext, publication: ApprovedFirstPartyPublication, mode: 'current' | 'historical', attempt: typeof contentOperationPublicationAttempts.$inferSelect): Promise<ManagedSiteNativeArticle> {
  const entryId = managedSiteNativeArticleEntryId(mode, publication.scheduleEntryId, attempt.entryId)
  let lineage: NativeArticleLineage
  if (mode === 'historical') lineage = await historicalArticleLineage(database, context, attempt)
  else {
    const [entry] = await database.select().from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.id, entryId), eq(contentOperationCalendarEntries.ownerUserId, context.ownerUserId))).limit(1)
    if (!entry || !entry.jobId || !entry.draftId || entry.id !== attempt.entryId || attempt.evidenceSnapshotHash !== entry.evidenceSnapshotHash || attempt.publicationSlug !== entry.publicationSlug || attempt.publicationPath !== entry.publicationPath || !['article', 'faq', 'service_page'].includes(entry.contentType) || !['en', 'zh-hant'].includes(entry.language)) fail('Content publication ledger lineage is mismatched.')
    lineage = { entryId: entry.id, calendarId: entry.calendarId, jobId: entry.jobId, draftId: entry.draftId, reviewId: entry.reviewId, riskGateId: 0, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, contentType: entry.contentType, language: entry.language, evidenceSnapshotHash: entry.evidenceSnapshotHash, contentHash: entry.contentHash || '', publicationContentHash: entry.publicationContentHash || '', publicationAuthorityReference: entry.publicationAuthorityReference, publicationSlug: entry.publicationSlug || '', publicationPath: entry.publicationPath || '', status: entry.status }
  }
  if (attempt.clientId !== context.targetRow.clientId || attempt.targetId !== context.targetRow.id || attempt.evidenceSnapshotHash !== lineage.evidenceSnapshotHash || attempt.publicationId !== `publication-${lineage.entryId}` || attempt.publicationSlug !== lineage.publicationSlug || attempt.publicationPath !== lineage.publicationPath) fail('Content publication ledger lineage is mismatched.')
  if (mode === 'historical' && (attempt.status !== 'delivered' || !SHA256.test(attempt.receiptFingerprint || '') || !SHA256.test(attempt.artifactFingerprint || ''))) fail('Historical content publication has no exact delivered authority.')
  if (mode === 'current' && attempt.status !== 'planned') fail('Current content publication reservation is no longer planned.')
  const [[calendar], [job], [draft], [gate]] = await Promise.all([
    database.select().from(contentOperationCalendars).where(and(eq(contentOperationCalendars.id, lineage.calendarId), eq(contentOperationCalendars.ownerUserId, context.ownerUserId), eq(contentOperationCalendars.clientId, context.targetRow.clientId))).limit(1),
    database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.id, lineage.jobId), eq(seoGeoContentJobs.ownerUserId, context.ownerUserId))).limit(1),
    database.select().from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.id, lineage.draftId), eq(seoGeoContentDrafts.jobId, lineage.jobId))).limit(1),
    mode === 'historical'
      ? database.select().from(seoGeoContentRiskGates).where(and(eq(seoGeoContentRiskGates.id, lineage.riskGateId), eq(seoGeoContentRiskGates.draftId, lineage.draftId), eq(seoGeoContentRiskGates.evidenceSnapshotHash, lineage.evidenceSnapshotHash))).limit(1)
      : database.select().from(seoGeoContentRiskGates).where(and(eq(seoGeoContentRiskGates.draftId, lineage.draftId), eq(seoGeoContentRiskGates.evidenceSnapshotHash, lineage.evidenceSnapshotHash))).orderBy(desc(seoGeoContentRiskGates.id)).limit(1),
  ])
  if (!calendar || !job || !draft || !gate || gate.status !== 'passed' || job.productionPlanId !== calendar.productionPlanId || job.productionDeliverableId !== lineage.productionDeliverableId || job.strategyRecommendationId !== lineage.strategyRecommendationId || job.evidenceSnapshotHash !== lineage.evidenceSnapshotHash || draft.safetyStatus !== 'passed' || !plain(draft.provenance) || draft.provenance.stage !== 'optimized') fail('Content publication immutable draft/risk lineage is invalid.')
  const bodyHash = sha256(draft.body)
  const expectedHash = attempt.publicationContentHash || attempt.contentHash
  if (bodyHash !== expectedHash || draft.contentHash !== attempt.contentHash || lineage.contentHash !== draft.contentHash || lineage.publicationContentHash !== bodyHash) fail('Content publication body hash is mismatched.')
  const expectedPath = publicationPathFor(context.targetRow.contentRoot, { clientId: context.targetRow.clientId, entryId: lineage.entryId, targetId: context.targetRow.targetId, targetOrigin: context.targetRow.targetOrigin, contentRoot: context.targetRow.contentRoot, contentType: lineage.contentType, language: lineage.language, title: draft.title, ownerScopeKey: ownerScopeKey(context.ownerUserId) }, attempt.publicationSlug)
  if (!expectedPath || attempt.publicationPath !== expectedPath) fail('Content publication path is not canonical for the exact target.')
  const authorityReference = attempt.authorityReference || lineage.publicationAuthorityReference
  if (authorityReference) {
    if (authorityReference !== attempt.authorityReference || authorityReference !== lineage.publicationAuthorityReference) fail('Content publication autopilot authority reference is mismatched.')
    if (/^[a-f0-9]{64}$/u.test(authorityReference)) {
      const [authorization] = await database.select().from(contentOperationMachineAuthorizations).where(and(eq(contentOperationMachineAuthorizations.ownerUserId, context.ownerUserId), eq(contentOperationMachineAuthorizations.entryId, lineage.entryId), eq(contentOperationMachineAuthorizations.authorizationFingerprint, authorityReference))).limit(1)
      if (mode === 'historical' && !matchesPublishedV4DeliveredAuthority(authorization, { ownerUserId: context.ownerUserId, clientId: context.targetRow.clientId, entryId: lineage.entryId, jobId: job.id, draftId: draft.id, targetId: context.targetRow.id, contentHash: draft.contentHash, evidenceSnapshotHash: lineage.evidenceSnapshotHash, authorityReference })) fail('Historical content publication machine authority is invalid.')
    } else if (!/^ref-autopilot-[A-Za-z0-9._:-]+$/u.test(authorityReference)) fail('Content publication autopilot authority reference is invalid.')
  } else {
    if (!lineage.reviewId) fail('Content publication is missing its exact approved review.')
    const [review] = await database.select().from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.id, lineage.reviewId), eq(seoGeoContentReviews.jobId, job.id), eq(seoGeoContentReviews.draftId, draft.id), eq(seoGeoContentReviews.reviewerUserId, context.ownerUserId), eq(seoGeoContentReviews.evidenceSnapshotHash, lineage.evidenceSnapshotHash), eq(seoGeoContentReviews.decision, 'approved_for_delivery'))).limit(1)
    if (!review) fail('Content publication exact approved review is missing.')
  }
  const article: ManagedSiteNativeArticle = { publicationId: `deliverable-${lineage.productionDeliverableId}`, slug: attempt.publicationSlug, title: draft.title, body: draft.body, contentHash: bodyHash, contentType: lineage.contentType, language: lineage.language, evidenceSnapshotHash: lineage.evidenceSnapshotHash }
  if (mode === 'current') {
    const current = articleFromPublication(publication)
    if (JSON.stringify(current) !== JSON.stringify(article) || publication.jobId !== `job-${job.id}` || publication.draftId !== `draft-${draft.id}` || publication.draftVersion !== draft.version || publication.productionPlanId !== `plan-${calendar.productionPlanId}` || publication.reviewId !== (authorityReference || `review-${lineage.reviewId}`)) fail('Current native content publication does not match its exact governed lineage.')
  }
  return article
}

export function managedSiteNativeArticleEntryId(mode: 'current' | 'historical', scheduleEntryId: string, attemptEntryId: number): number {
  const value = mode === 'current' ? Number(/^entry-([1-9]\d{0,14})$/u.exec(scheduleEntryId)?.[1]) : attemptEntryId
  if (!Number.isSafeInteger(value) || value < 1) fail('Content publication entry identity is malformed.', 'INVALID_INPUT')
  return value
}

async function loadArticles(database: any, context: NativeContext, publication: ApprovedFirstPartyPublication): Promise<{ articles: ManagedSiteNativeArticle[]; currentAttemptId: number | null; inventoryFingerprint: string; verificationAssetPath: string | null }> {
  const currentIsArticle = ['article', 'faq', 'service_page'].includes(publication.contentType)
  let currentAttempt: typeof contentOperationPublicationAttempts.$inferSelect | null = null
  let currentArticle: ManagedSiteNativeArticle | null = null
  if (currentIsArticle) {
    const entryId = Number(/^entry-([1-9]\d{0,14})$/u.exec(publication.scheduleEntryId)?.[1])
    if (!Number.isSafeInteger(entryId) || entryId < 1) fail('Current native content entry identity is malformed.')
    const rows = await database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, context.ownerUserId), eq(contentOperationPublicationAttempts.clientId, context.targetRow.clientId), eq(contentOperationPublicationAttempts.entryId, entryId), eq(contentOperationPublicationAttempts.targetId, context.targetRow.id), eq(contentOperationPublicationAttempts.status, 'planned'), eq(contentOperationPublicationAttempts.evidenceSnapshotHash, publication.evidenceSnapshotHash))).orderBy(desc(contentOperationPublicationAttempts.id)).limit(2)
    if (rows.length !== 1) fail('Current native content publication reservation is missing or ambiguous.')
    const reserved = rows[0] as typeof contentOperationPublicationAttempts.$inferSelect
    currentAttempt = reserved
    currentArticle = await validateArticleLineage(database, context, publication, 'current', reserved)
  }
  const delivered = await database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, context.ownerUserId), eq(contentOperationPublicationAttempts.clientId, context.targetRow.clientId), eq(contentOperationPublicationAttempts.targetId, context.targetRow.id), eq(contentOperationPublicationAttempts.status, 'delivered'))).orderBy(desc(contentOperationPublicationAttempts.id)).limit(MAX_ARTICLE_ATTEMPTS + 1)
  if (delivered.length > MAX_ARTICLE_ATTEMPTS) fail('Delivered content history exceeds the bounded native rebuild limit.')
  const articles = new Map<string, ManagedSiteNativeArticle>()
  const entries = new Set<number>()
  for (const attempt of delivered) {
    if (entries.has(attempt.entryId)) continue
    const article = await validateArticleLineage(database, context, publication, 'historical', attempt)
    const path = managedSiteArticleAssetPath(article)
    if (articles.has(path)) fail('Delivered content history contains a route collision.')
    entries.add(attempt.entryId); articles.set(path, article)
  }
  if (currentArticle) {
    const path = managedSiteArticleAssetPath(currentArticle)
    for (const [existingPath, article] of articles) if (existingPath === path || article.publicationId === currentArticle.publicationId) articles.delete(existingPath)
    articles.set(path, currentArticle)
  }
  return { articles: [...articles.values()], currentAttemptId: currentAttempt?.id || null, inventoryFingerprint: articleInventoryFingerprint(delivered), verificationAssetPath: currentArticle ? managedSiteArticleAssetPath(currentArticle) : null }
}

async function loadPages(database: any, context: NativeContext, publication: ApprovedFirstPartyPublication, pageWorkId?: number): Promise<{ pages: CompiledPageArtifact[]; inventoryFingerprint: string; verificationAssetPath: string | null }> {
  const rows = await database.select().from(managedSitePages).where(and(eq(managedSitePages.ownerUserId, context.ownerUserId), eq(managedSitePages.projectId, context.projectId), gt(managedSitePages.publishedVersion, 0))).orderBy(managedSitePages.route, managedSitePages.pageId).limit(MAX_PAGES + 1)
  if (rows.length > MAX_PAGES) fail('Published page inventory exceeds the bounded native rebuild limit.')
  const pages = new Map<string, CompiledPageArtifact>()
  const inventory: Array<{ pageId: string; route: string; publishedVersion: number; workId: number; artifactFingerprint: string }> = []
  for (const page of rows) {
    const workRows = await database.select().from(managedSitePagePublicationWorks).where(and(eq(managedSitePagePublicationWorks.ownerUserId, context.ownerUserId), eq(managedSitePagePublicationWorks.projectId, context.projectId), eq(managedSitePagePublicationWorks.pageId, page.pageId), eq(managedSitePagePublicationWorks.pageVersion, page.publishedVersion), eq(managedSitePagePublicationWorks.releaseId, context.release.id), eq(managedSitePagePublicationWorks.publicationTargetId, context.targetRow.id), eq(managedSitePagePublicationWorks.status, 'succeeded'))).orderBy(desc(managedSitePagePublicationWorks.id)).limit(2)
    if (!workRows.length) fail('Published page projection has no exact successful native artifact.')
    const envelope = buildManagedPageTransportEnvelope(workRows[0]!.artifact)
    if (!envelope || envelope.artifact.pageId !== page.pageId || envelope.artifact.pageVersion !== page.publishedVersion || envelope.artifact.route !== page.route || envelope.artifactFingerprint !== workRows[0]!.artifactFingerprint) fail('Published page artifact lineage is invalid.')
    if (pages.has(envelope.route)) fail('Published page history contains a route collision.')
    pages.set(envelope.route, envelope.artifact)
    inventory.push({ pageId: page.pageId, route: page.route, publishedVersion: page.publishedVersion, workId: workRows[0]!.id, artifactFingerprint: workRows[0]!.artifactFingerprint })
  }
  let verificationAssetPath: string | null = null
  if (publication.contentType === 'managed_page') {
    if (!pageWorkId) fail('Current managed page publication is missing its leased work identity.')
    const envelope = parseManagedPageTransport(publication.body)
    if (!envelope) fail('Current managed page transport is invalid.')
    const [work] = await database.select().from(managedSitePagePublicationWorks).where(and(eq(managedSitePagePublicationWorks.id, pageWorkId), eq(managedSitePagePublicationWorks.ownerUserId, context.ownerUserId), eq(managedSitePagePublicationWorks.projectId, context.projectId), eq(managedSitePagePublicationWorks.releaseId, context.release.id), eq(managedSitePagePublicationWorks.publicationTargetId, context.targetRow.id), eq(managedSitePagePublicationWorks.status, 'leased'))).limit(1)
    if (!work || work.pageId !== envelope.artifact.pageId || work.pageVersion !== envelope.artifact.pageVersion || work.contentHash !== publication.contentHash || work.artifactFingerprint !== envelope.artifactFingerprint || JSON.stringify(work.artifact) !== JSON.stringify(envelope.artifact)) fail('Current managed page work does not match its immutable transport.')
    for (const [route, artifact] of pages) if (route === envelope.route || artifact.pageId === envelope.artifact.pageId) pages.delete(route)
    pages.set(envelope.route, envelope.artifact)
    verificationAssetPath = managedSitePageAssetPath(envelope.route)
  }
  return { pages: [...pages.values()], inventoryFingerprint: pageInventoryFingerprint(inventory), verificationAssetPath }
}

function mediaReferences(pages: readonly CompiledPageArtifact[]) {
  const references = new Map<string, { sha256: string; width: number; format: string; assetId: string; assetVersion: number; assetSha256: string }>()
  for (const page of pages) for (const block of page.blocks) for (const media of block.media) for (const part of media.srcset.split(',')) {
    const matched = /^\s*media-ref:([a-f0-9]{64}):([1-9]\d{0,5}):(jpeg|png|webp|avif)\s+([1-9]\d{0,5})w\s*$/u.exec(part)
    if (!matched || Number(matched[2]) !== Number(matched[4])) fail('Compiled page media reference is malformed.')
    const key = `${matched[1]}:${matched[2]}:${matched[3]}`
    const value = { sha256: matched[1]!, width: Number(matched[2]), format: matched[3]!, assetId: media.assetId, assetVersion: media.assetVersion, assetSha256: media.assetSha256 }
    const previous = references.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) fail('Compiled page media reference collides across asset authority.')
    references.set(key, value)
  }
  if (references.size > MAX_MEDIA_REFERENCES) fail('Managed page media references exceed the bounded native rebuild limit.')
  return references
}

async function mediaResolver(database: any, context: NativeContext, pages: readonly CompiledPageArtifact[], now: Date) {
  const references = mediaReferences(pages)
  if (!references.size) return () => fail('Rendered page unexpectedly requested an undeclared media reference.')
  const hashes = [...new Set([...references.values()].map(value => value.sha256))]
  const variants = await database.select().from(managedSiteMediaVariants).where(and(eq(managedSiteMediaVariants.ownerUserId, context.ownerUserId), eq(managedSiteMediaVariants.projectId, context.projectId), inArray(managedSiteMediaVariants.sha256, hashes))).limit(MAX_MEDIA_ROWS + 1) as MediaVariantRow[]
  if (variants.length > MAX_MEDIA_ROWS) fail('Managed media variant inventory exceeds the bounded native rebuild limit.')
  const versionIds = [...new Set(variants.map(row => row.assetVersionId))]
  const objectIds = [...new Set(variants.map(row => row.mediaObjectId))]
  const versions: MediaVersionRow[] = versionIds.length ? await database.select().from(managedSiteMediaAssetVersions).where(and(eq(managedSiteMediaAssetVersions.ownerUserId, context.ownerUserId), eq(managedSiteMediaAssetVersions.projectId, context.projectId), inArray(managedSiteMediaAssetVersions.id, versionIds))).limit(MAX_MEDIA_ROWS + 1) : []
  const objects: MediaObjectRow[] = objectIds.length ? await database.select().from(managedSiteMediaObjects).where(and(eq(managedSiteMediaObjects.ownerUserId, context.ownerUserId), eq(managedSiteMediaObjects.projectId, context.projectId), inArray(managedSiteMediaObjects.id, objectIds))).limit(MAX_MEDIA_ROWS + 1) : []
  const assets: MediaAssetRow[] = versions.length ? await database.select().from(managedSiteMediaAssets).where(and(eq(managedSiteMediaAssets.ownerUserId, context.ownerUserId), eq(managedSiteMediaAssets.projectId, context.projectId), inArray(managedSiteMediaAssets.currentVersionId, versions.map(row => row.id)))).limit(MAX_MEDIA_ROWS + 1) : []
  const connectionIds = [...new Set(objects.map(row => row.connectionId))]
  const connections: StorageConnectionRow[] = connectionIds.length ? await database.select().from(managedSiteStorageConnections).where(and(eq(managedSiteStorageConnections.ownerUserId, context.ownerUserId), eq(managedSiteStorageConnections.projectId, context.projectId), inArray(managedSiteStorageConnections.id, connectionIds))).limit(3) : []
  const versionById = new Map(versions.map(row => [row.id, row])); const objectById = new Map(objects.map(row => [row.id, row])); const assetByVersion = new Map(assets.map(row => [row.currentVersionId, row])); const connectionById = new Map(connections.map(row => [row.id, row]))
  const urls = new Map<string, string>()
  for (const [key, reference] of references) {
    const matches = variants.filter(row => row.sha256 === reference.sha256 && row.width === reference.width && row.format === reference.format)
    if (matches.length !== 1) fail('Managed media reference did not resolve to one exact public variant.')
    const variant = matches[0]!; const version = versionById.get(variant.assetVersionId); const object = objectById.get(variant.mediaObjectId); const asset = version ? assetByVersion.get(version.id) : null; const connection = object ? connectionById.get(object.connectionId) : null
    const rights = plain(asset?.rightsMetadata) ? asset!.rightsMetadata : {}
    const metadata = plain(version?.metadata) ? version!.metadata : {}
    if (!version || !object || !asset || !connection || version.assetId !== reference.assetId || version.version !== reference.assetVersion || version.sha256 !== reference.assetSha256 || asset.assetId !== reference.assetId || asset.currentVersionId !== version.id || asset.currentVersion !== reference.assetVersion || asset.status !== 'ready' || asset.visibility !== 'public' || asset.deletedAt || rights.publishAllowed !== true || typeof rights.expiresAt === 'string' && Date.parse(rights.expiresAt) <= now.getTime() || metadata.scannerVerdict !== 'passed' || object.objectKind !== 'variant' || object.assetVersionId !== version.id || object.sha256 !== variant.sha256 || object.deletedAt || connection.providerKey !== 's3_compatible' || connection.status !== 'verified' || !connection.healthReceiptFingerprint || !connection.scannerAuthorityFingerprint || !connection.scannerHealthReceiptFingerprint || !connection.scannerVerifiedAt) fail('Managed media public storage/scanner/rights authority is invalid.')
    const config = plain(connection.configuration) ? connection.configuration : {}
    if (typeof config.publicCdnOrigin !== 'string' || typeof config.prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$/u.test(config.prefix) || config.prefix.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,510}$/u.test(object.objectKey) || object.objectKey.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('Managed media public object path is invalid.')
    let origin: URL
    try { origin = new URL(assertPublicHttpsUrl(config.publicCdnOrigin, 'Managed media CDN origin')) } catch { fail('Managed media public CDN origin is invalid.') }
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) fail('Managed media public CDN origin is not a fixed HTTPS origin.')
    urls.set(key, `${origin.origin}/${config.prefix.replace(/\/$/u, '')}/${object.objectKey}`)
  }
  return (reference: { sha256: string; width: number; format: string }) => urls.get(`${reference.sha256}:${reference.width}:${reference.format}`) || fail('Rendered page media reference is outside the authorized immutable set.')
}

function siteFingerprint(assets: readonly { path: string; contentType: string; content: string }[]): string {
  return sha256(JSON.stringify(assets.map(asset => ({ path: asset.path, contentType: asset.contentType, sha256: sha256(asset.content) }))))
}

async function executeLocked(database: any, input: NativeInput, plan: Extract<ReturnType<typeof planFirstPartyPublication>, { status: 'planned' }>): Promise<FirstPartyExecutionResult> {
  const context = await loadAuthority(database, input)
  const articleState = await loadArticles(database, context, input.publication)
  await assertExclusivePublication(database, context, input, articleState.currentAttemptId)
  const pageState = await loadPages(database, context, input.publication, input.pageWorkId)
  const resolveMediaReference = await mediaResolver(database, context, pageState.pages, input.now)
  const assets = renderManagedSiteNativeStaticAssets({ bundle: context.bundle, canonicalOrigin: `https://${context.release.canonicalDomain}`, pages: pageState.pages, articles: articleState.articles, resolveMediaReference })
  const nonHomepage = assets.find(asset => asset.contentType.startsWith('text/html') && asset.path !== 'index.html')
  // The deployment driver always verifies the exact homepage bytes. A second path
  // strengthens multi-page/article deployments, but a legitimate one-page site has
  // no non-home route and must not be made unpublishable for that reason.
  const verificationAssetPath = articleState.verificationAssetPath || (pageState.verificationAssetPath && pageState.verificationAssetPath !== 'index.html' ? pageState.verificationAssetPath : nonHomepage?.path)
  const nativeFingerprint = siteFingerprint(assets)
  const requestFingerprint = sha256(JSON.stringify({ version: 'managed-site-native-publication-v1', ownerUserId: context.ownerUserId, projectId: context.projectId, releaseId: context.release.id, releaseProjectionFingerprint: context.release.projectionFingerprint, productionReceiptFingerprint: context.release.activeDeploymentReceiptFingerprint, targetId: context.targetRow.targetId, planIdempotencyKey: plan.command.idempotencyKey, nativeFingerprint }))
  const config = configuration(input.dependencies || {})
  const resolver = input.dependencies?.credentialResolver || resolveManagedSiteCredential
  const credential = await resolver(config.cloudflare.apiTokenReference)
  if (!credential.ok) fail('Cloudflare API credential reference is unavailable.', 'CREDENTIAL_MISSING')
  const cloudflareFetch = input.dependencies?.cloudflareFetch || globalThis.fetch
  if (typeof cloudflareFetch !== 'function') fail('Cloudflare publication transport is unavailable.', 'EXECUTOR_NOT_CONFIGURED')
  const options: CloudflarePagesOptions & { productionProbe?: ManagedSiteProductionProbe } = { fetchImpl: cloudflareFetch, accountId: config.cloudflare.accountId, apiToken: credential.value, projectPrefix: config.cloudflare.projectPrefix, ...(input.dependencies?.now ? { now: input.dependencies.now } : {}), ...(input.dependencies?.sleep ? { sleep: input.dependencies.sleep } : {}), ...(input.dependencies?.productionProbe ? { productionProbe: input.dependencies.productionProbe } : {}) }
  const deploy = input.dependencies?.deploy || deployCloudflarePagesProduction
  await mutationAuthorityRecheck(database, context, input, articleState.currentAttemptId, { articleInventoryFingerprint: articleState.inventoryFingerprint, pageInventoryFingerprint: pageState.inventoryFingerprint })
  const result = await deploy({ ownerUserId: context.ownerUserId, projectId: context.projectId, releaseId: context.release.id, canonicalDomain: context.release.canonicalDomain, requestFingerprint, assets, timeoutMs: 30_000, ...(verificationAssetPath ? { verificationAssetPath } : {}) }, options)
  if (!result.deploymentId || result.deploymentUrl !== `https://${context.release.canonicalDomain}/`) fail('Cloudflare native deployment receipt did not match the canonical release.', 'RESPONSE_INVALID')
  return { status: 'delivered', remoteState: 'updated', publicationId: input.publication.productionDeliverableId, contentHash: input.publication.contentHash, remoteRevision: `cloudflare-pages:${result.deploymentId}:${nativeFingerprint.slice(0, 24)}`, artifactFingerprint: plan.command.artifactFingerprint, idempotencyKey: plan.command.idempotencyKey }
}

/** Returns null only for non-reserved targets; reserved targets always execute natively or fail closed. */
export async function executeManagedSiteNativePublicationIfConfigured(input: NativeInput): Promise<FirstPartyExecutionResult | null> {
  if (!nativeCandidate(input.target)) return null
  const plan = planFirstPartyPublication(input.target, input.publication, input.now.toISOString())
  if (plan.status !== 'planned') return plan
  const database = input.dependencies?.database || getDatabase()
  if (!database || typeof database.transaction !== 'function') return { status: 'blocked', code: 'EXECUTOR_NOT_CONFIGURED', reasons: ['Native managed-site publication database is unavailable.'] }
  try { return await database.transaction((transaction: any) => executeLocked(transaction, input, plan)) }
  catch (error) { return classifyManagedSiteNativePublicationFailure(error) }
}
