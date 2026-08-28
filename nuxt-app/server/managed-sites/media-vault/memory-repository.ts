import { createError } from 'h3'
import type { MediaAssetProjection, MediaEvent, MediaQuota, MediaTenantScope, MediaUploadSession, MediaVaultRepository } from './types'

const scopeKey = (scope: MediaTenantScope) => `${scope.ownerUserId}:${scope.projectId}`
const compound = (scope: MediaTenantScope, value: string) => `${scopeKey(scope)}:${value}`
function clone<T>(value: T): T { return structuredClone(value) }

export function createMemoryMediaVaultRepository(initialQuota: Partial<MediaQuota> = {}): MediaVaultRepository {
  const uploads = new Map<string, MediaUploadSession>(); const assets = new Map<string, MediaAssetProjection>(); const events = new Map<string, MediaEvent[]>(); const quotas = new Map<string, MediaQuota>(); const usages = new Map<string, number>()
  const defaultQuota = (scope: MediaTenantScope): MediaQuota => ({ maxOriginalBytes: 500 * 1024 * 1024, maxAssetCount: 5000, maxMonthlyUploadBytes: 1024 * 1024 * 1024, maxMonthlyProcessingCount: 5000, originalBytesUsed: 0, assetCountUsed: 0, monthlyUploadBytesUsed: 0, monthlyProcessingCountUsed: 0, periodKey: new Date().toISOString().slice(0, 7), ...initialQuota })
  let transactionTail = Promise.resolve()
  const repository: MediaVaultRepository = {
    async transaction<T>(work: (repository: MediaVaultRepository) => Promise<T>): Promise<T> { let release!: () => void; const preceding = transactionTail; transactionTail = new Promise<void>(resolve => { release = resolve }); await preceding; try { return await work(repository) } finally { release() } },
    async getQuota(scope) { return clone(quotas.get(scopeKey(scope)) || defaultQuota(scope)) }, async saveQuota(scope, quota) { quotas.set(scopeKey(scope), clone(quota)) },
    async findUploadById(scope, uploadId) { const value = uploads.get(compound(scope, uploadId)); return value ? clone(value) : null },
    async findUploadByIdempotency(scope, idempotencyKey) { const value = [...uploads.values()].find(item => scopeKey(item) === scopeKey(scope) && item.idempotencyKey === idempotencyKey); return value ? clone(value) : null },
    async insertUpload(upload) { const key = compound(upload, upload.uploadId); if (uploads.has(key)) throw createError({ statusCode: 409, statusMessage: 'Media upload identity collided.' }); uploads.set(key, clone(upload)) },
    async updateUpload(scope, uploadId, patch) { const key = compound(scope, uploadId); const value = uploads.get(key); if (!value) return null; const updated = { ...value, ...clone(patch), ownerUserId: value.ownerUserId, projectId: value.projectId, uploadId: value.uploadId }; uploads.set(key, updated); return clone(updated) },
    async findAsset(scope, assetId) { const value = assets.get(compound(scope, assetId)); return value ? clone(value) : null },
    async findReadyAssetByHash(scope, sha256) { const value = [...assets.values()].find(item => scopeKey(item) === scopeKey(scope) && item.sha256 === sha256 && item.status === 'ready'); return value ? clone(value) : null },
    async listAssets(scope) { return [...assets.values()].filter(item => scopeKey(item) === scopeKey(scope) && item.status !== 'deleted').map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) },
    async insertAsset(asset) { const key = compound(asset, asset.assetId); if (assets.has(key)) throw createError({ statusCode: 409, statusMessage: 'Media asset identity collided.' }); assets.set(key, clone(asset)) },
    async updateAsset(scope, assetId, patch) { const key = compound(scope, assetId); const value = assets.get(key); if (!value) return null; const updated = { ...value, ...clone(patch), ownerUserId: value.ownerUserId, projectId: value.projectId, assetId: value.assetId }; assets.set(key, updated); return clone(updated) },
    async appendReplacementVersion(scope, replacement) { const key = compound(scope, replacement.assetId); const current = assets.get(key); if (!current || replacement.version !== current.version + 1) return null; assets.set(key, clone(replacement)); return clone(replacement) },
    async claimAssetStatus(scope, assetId, from, to) { const key = compound(scope, assetId); const value = assets.get(key); if (!value || !from.includes(value.status)) return false; assets.set(key, { ...value, status: to }); return true },
    async listObjectKeys(scope, assetId) { const asset = assets.get(compound(scope, assetId)); return asset ? [asset.originalObjectKey, ...asset.variants.map(item => item.objectKey)] : [] },
    async recordProcessingRun() {},
    async appendEvent(scope, event) { const list = events.get(scopeKey(scope)) || []; const existing = list.find(item => item.receiptFingerprint === event.receiptFingerprint); if (existing) return clone(existing); list.push(clone(event)); events.set(scopeKey(scope), list); return clone(event) },
    async listEvents(scope, assetId) { return (events.get(scopeKey(scope)) || []).filter(event => !assetId || event.assetId === assetId).map(clone) },
    async countActiveUsages(scope, assetId) { return usages.get(compound(scope, assetId)) || 0 }, async setActiveUsageCount(scope, assetId, count) { usages.set(compound(scope, assetId), count) },
  }
  return repository
}
