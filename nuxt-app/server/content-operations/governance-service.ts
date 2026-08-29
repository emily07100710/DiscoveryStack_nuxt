import { createError } from 'h3'
import { z } from 'zod'
import { normalizeEntityStrategyProfile, normalizeQueryOwnership } from './balanced-autopilot'
import { createContentOperationsRepository, type ContentOperationsRepository } from './repository'
import { normalizePublicHttpsOrigin, stableFingerprint } from './normalization'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const entityInput = z.object({
  targetRowId: z.number().int().positive(), idempotencyKey: z.string().trim().min(1).max(128), canonicalBrandName: z.string().trim().min(1).max(160), brandAliases: z.array(z.string().max(160)).max(40), canonicalWebsiteOrigin: z.string().max(2048), businessType: z.string().trim().min(1).max(160), primaryLocale: z.string().trim().min(1).max(32), secondaryLocales: z.array(z.string().max(32)).max(20), primaryLocations: z.array(z.string().max(160)).max(100), serviceAreas: z.array(z.string().max(160)).max(100), primaryServices: z.array(z.string().max(200)).min(1).max(100), secondaryServices: z.array(z.string().max(200)).max(100), targetAudience: z.array(z.string().max(200)).max(100), primaryQueryClusters: z.array(z.string().max(500)).min(1).max(100), supportingQueryClusters: z.array(z.string().max(500)).max(100), canonicalPillarPages: z.array(z.string().max(2048)).max(100), servicePageBindings: z.record(z.string(), z.string().max(2048)), approvedBrandFacts: z.array(z.string().max(1000)).max(200), approvedDifferentiators: z.array(z.string().max(1000)).max(100), prohibitedClaims: z.array(z.string().max(1000)).max(100), preferredTone: z.string().trim().min(1).max(160), requiredDisclosures: z.array(z.string().max(1000)).max(100), internalLinkPolicy: z.string().trim().min(1).max(500), structuredDataIdentity: z.record(z.string(), z.string().max(1000)), evidenceSnapshotHash: hash,
}).strict()
const queryInput = z.object({ targetRowId: z.number().int().positive(), idempotencyKey: z.string().trim().min(1).max(128), ownerPageId: z.string().trim().min(1).max(2048), normalizedQuery: z.string().trim().min(1).max(500), queryCluster: z.string().trim().min(1).max(500), supportingArticleIds: z.array(z.string().trim().min(1).max(256)).max(200), evidenceSnapshotHash: hash }).strict()

function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
async function scope(ownerUserId: number, clientId: number, targetRowId: number, repository: ContentOperationsRepository) {
  const [client, target] = await Promise.all([repository.findClient(ownerUserId, clientId), repository.findPublicationTarget(ownerUserId, targetRowId)])
  if (!client || client.status !== 'active') notFound('Content operation client was not found for this owner.')
  if (!target || target.clientId !== clientId || target.status !== 'active' || !target.websiteId) notFound('An active owner/client/website publication target is required.')
  return { client, target, websiteId: target.websiteId }
}

export async function saveOwnerEntityStrategyProfile(ownerUserId: number, clientId: number, value: unknown, repository?: ContentOperationsRepository, at = new Date()) {
  const db = repository || createContentOperationsRepository()
  const parsed = entityInput.safeParse(value)
  if (!parsed.success || !Number.isFinite(at.getTime())) throw createError({ statusCode: 422, statusMessage: 'Invalid Entity Strategy Profile input.' })
  const currentScope = await scope(ownerUserId, clientId, parsed.data.targetRowId, db)
  if (normalizePublicHttpsOrigin(parsed.data.canonicalWebsiteOrigin) !== normalizePublicHttpsOrigin(currentScope.client.canonicalSiteOrigin)) conflict('Entity Strategy canonical website must match the owner client origin.')
  const existing = await db.listEntityStrategyProfiles(ownerUserId, clientId, currentScope.websiteId)
  const normalized = normalizeEntityStrategyProfile({ ...parsed.data, canonicalWebsiteOrigin: normalizePublicHttpsOrigin(parsed.data.canonicalWebsiteOrigin), version: Math.max(0, ...existing.map(row => row.version)) + 1, status: 'active', effectiveAt: at.toISOString(), revokedAt: null })
  const replay = existing.find(row => row.profileFingerprint === normalized.profileFingerprint)
  if (replay) return { profile: replay, replayed: true }
  if (existing.some(row => row.status === 'active')) conflict('Revoke the active Entity Strategy Profile before creating a replacement.')
  const row = await db.insertEntityStrategyProfile({ ...normalized, profileId: `entity-profile-${normalized.profileFingerprint.slice(0, 32)}`, ownerUserId, clientId, websiteId: currentScope.websiteId, effectiveAt: at, revokedAt: null, activeScopeKey: stableFingerprint({ ownerUserId, clientId, websiteId: currentScope.websiteId }) })
  return { profile: row, replayed: false }
}

export async function listOwnerEntityStrategyProfiles(ownerUserId: number, clientId: number, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  if (!await db.findClient(ownerUserId, clientId)) notFound('Content operation client was not found for this owner.')
  return { profiles: await db.listEntityStrategyProfiles(ownerUserId, clientId) }
}

export async function revokeOwnerEntityStrategyProfile(ownerUserId: number, clientId: number, profileId: string, repository?: ContentOperationsRepository, at = new Date()) {
  const db = repository || createContentOperationsRepository()
  const row = (await db.listEntityStrategyProfiles(ownerUserId, clientId)).find(item => item.profileId === profileId)
  if (!row) notFound('Entity Strategy Profile was not found for this owner client.')
  const revoked = await db.revokeEntityStrategyProfile(ownerUserId, profileId, at)
  return { profile: revoked || row, replayed: !revoked }
}

export async function saveOwnerQueryOwnership(ownerUserId: number, clientId: number, value: unknown, repository?: ContentOperationsRepository, at = new Date()) {
  const db = repository || createContentOperationsRepository()
  const parsed = queryInput.safeParse(value)
  if (!parsed.success || !Number.isFinite(at.getTime())) throw createError({ statusCode: 422, statusMessage: 'Invalid Query Ownership input.' })
  const currentScope = await scope(ownerUserId, clientId, parsed.data.targetRowId, db)
  const normalized = normalizeQueryOwnership({ ownerPageId: parsed.data.ownerPageId, normalizedQuery: parsed.data.normalizedQuery, queryCluster: parsed.data.queryCluster, supportingArticleIds: parsed.data.supportingArticleIds, evidenceSnapshotHash: parsed.data.evidenceSnapshotHash, status: 'active' })
  const existing = await db.findQueryOwnership(ownerUserId, clientId, currentScope.websiteId, normalized.normalizedQuery)
  if (existing?.fingerprint === normalized.fingerprint) return { ownership: existing, replayed: true }
  if (existing) conflict('Revoke the active canonical query owner before creating a replacement.')
  const row = await db.insertQueryOwnership({ ...normalized, ownerUserId, clientId, websiteId: currentScope.websiteId, revokedAt: null, activeScopeKey: stableFingerprint({ ownerUserId, clientId, websiteId: currentScope.websiteId, normalizedQuery: normalized.normalizedQuery }) })
  return { ownership: row, replayed: false }
}

export async function listOwnerQueryOwnership(ownerUserId: number, clientId: number, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  if (!await db.findClient(ownerUserId, clientId)) notFound('Content operation client was not found for this owner.')
  return { ownership: await db.listQueryOwnership(ownerUserId, clientId) }
}

export async function revokeOwnerQueryOwnership(ownerUserId: number, clientId: number, fingerprint: string, repository?: ContentOperationsRepository, at = new Date()) {
  const db = repository || createContentOperationsRepository()
  const row = (await db.listQueryOwnership(ownerUserId, clientId)).find(item => item.fingerprint === fingerprint)
  if (!row) notFound('Query Ownership was not found for this owner client.')
  const revoked = await db.revokeQueryOwnership(ownerUserId, fingerprint, at)
  return { ownership: revoked || row, replayed: !revoked }
}
