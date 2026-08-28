export const MEDIA_VAULT_VERSION = 'managed-site-media-vault-v1' as const
export const MEDIA_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const
export const MEDIA_VARIANT_KEYS = ['thumbnail', 'small', 'medium', 'large', 'original_policy'] as const

export type MediaVisibility = 'public' | 'private' | 'internal'
export type MediaAssetStatus = 'pending_upload' | 'uploaded' | 'quarantined' | 'processing' | 'ready' | 'trashed' | 'deletion_pending' | 'deleted' | 'failed'
export type MediaScannerVerdict = 'passed' | 'blocked' | 'owner_review' | 'not_configured'

export interface MediaTenantScope { ownerUserId: number; projectId: number }
export interface MediaActor extends MediaTenantScope { actorUserId: number | null; authority: 'owner_session' | 'customer_session' | 'system_workflow' | 'system_test'; role: 'platform_owner' | 'customer_admin' | 'editor' | 'viewer' }
export interface MediaQuota { maxOriginalBytes: number; maxAssetCount: number; maxMonthlyUploadBytes: number; maxMonthlyProcessingCount: number; originalBytesUsed: number; assetCountUsed: number; monthlyUploadBytesUsed: number; monthlyProcessingCountUsed: number; periodKey: string }
export interface MediaQuotaDelta { originalBytes: number; assetCount: number; uploadBytes: number; processingCount: number }
export interface MediaQuotaClaim { idempotencyKey: string; requestFingerprint: string; periodKey: string; delta: MediaQuotaDelta; status: 'reserved' | 'committed' | 'released'; replayed: boolean }

export interface MediaUploadRequest {
  filename: string
  declaredMime: string
  declaredBytes: number
  visibility: MediaVisibility
  idempotencyKey: string
}

export interface MediaRightsMetadata {
  license: string | null
  source: string | null
  photographer: string | null
  consentReference: string | null
  publishAllowed: boolean
  expiresAt: string | null
}

export interface MediaUploadSession extends MediaTenantScope {
  uploadId: string
  assetId: string
  objectKey: string
  filename: string
  declaredMime: string
  declaredBytes: number
  visibility: MediaVisibility
  status: 'issued' | 'completing' | 'completed' | 'expired' | 'cancelled' | 'rejected'
  idempotencyKey: string
  requestFingerprint: string
  expiresAt: string
  completionFingerprint: string | null
  quotaOriginalBytesCommitted: number
  quotaAssetCountCommitted: number
}

export interface MediaObjectHead { byteSize: number; contentType: string | null; etag: string | null; versionReference: string | null; metadata: Readonly<Record<string, string>> }
export interface MediaStoredObject { objectKey: string; byteSize: number; sha256: string; contentType: string; versionReference: string | null }
export interface MediaSignedAuthorization { method: 'PUT' | 'GET'; url: string; expiresAt: string; requiredHeaders: Readonly<Record<string, string>>; cacheControl: 'private, no-store' }

export interface MediaStoragePort {
  readonly kind: 'memory_test' | 'local_dev' | 's3_compatible'
  createUploadIntent(input: MediaTenantScope & { uploadId: string; objectKey: string; byteSize: number; contentType: string; expiresAt: Date }): Promise<MediaSignedAuthorization>
  completeUpload(input: MediaTenantScope & { uploadId: string; objectKey: string; byteSize: number; contentType: string }): Promise<MediaObjectHead>
  headObject(input: MediaTenantScope & { objectKey: string }): Promise<MediaObjectHead | null>
  readForProcessing(input: MediaTenantScope & { objectKey: string; maxBytes: number }): Promise<Uint8Array>
  writeVariant(input: MediaTenantScope & { objectKey: string; bytes: Uint8Array; contentType: string; sha256: string }): Promise<MediaStoredObject>
  createSignedRead(input: MediaTenantScope & { objectKey: string; expiresAt: Date }): Promise<MediaSignedAuthorization>
  deleteObject(input: MediaTenantScope & { objectKey: string }): Promise<{ deleted: boolean; receiptReference: string }>
  healthCheck(): Promise<{ ready: boolean; mode: string; reason?: string }>
  /** Test/dev-only server relay. S3-compatible production uploads use signed direct PUT and omit this method. */
  writeUploadBytes?(input: MediaTenantScope & { objectKey: string; bytes: Uint8Array; contentType: string }): Promise<void>
}

export interface MediaInspection { mime: typeof MEDIA_MIME_ALLOWLIST[number]; width: number; height: number; frameCount: number; orientation: number | null; hasExif: boolean; hasGps: boolean }
export interface MediaSecurityScanner { scan(input: { bytes: Uint8Array; sha256: string; tenant: MediaTenantScope }): Promise<{ verdict: MediaScannerVerdict; reasonCode: string | null; scannerReference: string | null }>; healthCheck?(): Promise<{ ready: boolean; mode: string; reason?: string }> }
export interface MediaVariantOutput { key: typeof MEDIA_VARIANT_KEYS[number]; format: 'jpeg' | 'png' | 'webp' | 'avif'; width: number; height: number; bytes: Uint8Array; sha256: string; transformation: MediaTransformation }
export interface MediaTransformation { crop?: { x: number; y: number; width: number; height: number; aspect: 'free' | '1:1' | '4:3' | '3:2' | '16:9' | 'portrait' }; focalPoint?: { x: number; y: number }; rotation?: 0 | 90 | 180 | 270; stripMetadata: true; preserveOrientation: true }
export interface MediaImageProcessor { inspect(bytes: Uint8Array): Promise<MediaInspection>; produceVariants(input: { bytes: Uint8Array; inspection: MediaInspection; transformation: MediaTransformation }): Promise<MediaVariantOutput[]> }

export interface MediaAssetProjection extends MediaTenantScope {
  assetId: string; version: number; status: MediaAssetStatus; visibility: MediaVisibility; filename: string; declaredMime: string; sniffedMime: string | null; byteSize: number; width: number | null; height: number | null; sha256: string | null; originalObjectKey: string; processingFingerprint: string | null; scannerVerdict: MediaScannerVerdict | null; variants: MediaVariantProjection[]; collectionId: number | null; tags: Array<{ id: number; name: string; canonicalKey: string }>; rightsMetadata: MediaRightsMetadata; createdAt: string; trashedAt: string | null; retentionUntil: string | null; deletedAt: string | null
}
export interface MediaVariantProjection { key: string; format: string; width: number; height: number; byteSize: number; sha256: string; objectKey: string; transformation: MediaTransformation }
export interface MediaEvent { eventType: string; assetId: string | null; uploadId: string | null; receiptFingerprint: string; metadata: Readonly<Record<string, unknown>>; occurredAt: string }

export interface MediaVaultRepository {
  transaction<T>(work: (repository: MediaVaultRepository) => Promise<T>): Promise<T>
  getQuota(scope: MediaTenantScope): Promise<MediaQuota>
  reserveQuota(scope: MediaTenantScope, input: { idempotencyKey: string; requestFingerprint: string; delta: MediaQuotaDelta }): Promise<MediaQuotaClaim>
  settleQuota(scope: MediaTenantScope, input: { idempotencyKey: string; requestFingerprint: string; committed: MediaQuotaDelta }): Promise<MediaQuotaClaim>
  releaseQuota(scope: MediaTenantScope, input: { idempotencyKey: string; requestFingerprint: string }): Promise<MediaQuotaClaim>
  creditQuota(scope: MediaTenantScope, input: { idempotencyKey: string; requestFingerprint: string; delta: Pick<MediaQuotaDelta, 'originalBytes' | 'assetCount'> }): Promise<MediaQuotaClaim>
  /** Legacy projection writer retained for migration/backfill only; runtime mutations use atomic claims. */
  saveQuota(scope: MediaTenantScope, quota: MediaQuota): Promise<void>
  findUploadById(scope: MediaTenantScope, uploadId: string): Promise<MediaUploadSession | null>
  findUploadByIdempotency(scope: MediaTenantScope, idempotencyKey: string): Promise<MediaUploadSession | null>
  insertUpload(upload: MediaUploadSession): Promise<void>
  updateUpload(scope: MediaTenantScope, uploadId: string, patch: Partial<MediaUploadSession>): Promise<MediaUploadSession | null>
  claimUploadStatus(scope: MediaTenantScope, uploadId: string, from: MediaUploadSession['status'][], to: MediaUploadSession['status']): Promise<boolean>
  findAsset(scope: MediaTenantScope, assetId: string): Promise<MediaAssetProjection | null>
  findReadyAssetByHash(scope: MediaTenantScope, sha256: string): Promise<MediaAssetProjection | null>
  listAssets(scope: MediaTenantScope): Promise<MediaAssetProjection[]>
  insertAsset(asset: MediaAssetProjection): Promise<void>
  updateAsset(scope: MediaTenantScope, assetId: string, patch: Partial<MediaAssetProjection>): Promise<MediaAssetProjection | null>
  appendReplacementVersion(scope: MediaTenantScope, replacement: MediaAssetProjection): Promise<MediaAssetProjection | null>
  claimAssetStatus(scope: MediaTenantScope, assetId: string, from: MediaAssetStatus[], to: MediaAssetStatus): Promise<boolean>
  listObjectKeys(scope: MediaTenantScope, assetId: string): Promise<string[]>
  getOriginalBytesForAsset(scope: MediaTenantScope, assetId: string): Promise<number>
  recordProcessingRun(scope: MediaTenantScope, input: { assetId: string; status: 'quarantined' | 'failed' | 'succeeded'; scannerVerdict: MediaScannerVerdict; processingFingerprint: string; errorCode: string | null }): Promise<void>
  appendEvent(scope: MediaTenantScope, event: MediaEvent): Promise<MediaEvent>
  listEvents(scope: MediaTenantScope, assetId?: string): Promise<MediaEvent[]>
  countActiveUsages(scope: MediaTenantScope, assetId: string): Promise<number>
  setActiveUsageCount(scope: MediaTenantScope, assetId: string, count: number): Promise<void>
}
