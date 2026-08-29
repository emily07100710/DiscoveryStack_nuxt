import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createError } from 'h3'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import type { MediaObjectHead, MediaSignedAuthorization, MediaStoragePort, MediaStoredObject, MediaTenantScope } from './types'

const MAX_PROCESSING_BYTES = 52_428_800
const SAFE_KEY = /^media\/owners\/[1-9]\d*\/projects\/[1-9]\d*\/(?:uploads|assets)\/[a-z0-9/-]{8,240}\.[a-z0-9]{2,8}$/u

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function assertScope(scope: MediaTenantScope): void {
  if (!Number.isSafeInteger(scope.ownerUserId) || scope.ownerUserId < 1 || !Number.isSafeInteger(scope.projectId) || scope.projectId < 1) throw createError({ statusCode: 422, statusMessage: 'Media tenant scope is invalid.' })
}
function assertObjectKey(scope: MediaTenantScope, key: string): void {
  assertScope(scope)
  if (!SAFE_KEY.test(key) || !key.startsWith(`media/owners/${scope.ownerUserId}/projects/${scope.projectId}/`)) throw createError({ statusCode: 403, statusMessage: 'Media object authority is outside the active tenant.' })
}
function safeExpiry(expiresAt: Date): number {
  const seconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 900) throw createError({ statusCode: 422, statusMessage: 'Media authorization expiry must be between 1 and 900 seconds.' })
  return seconds
}
async function boundedBody(body: any, maxBytes: number): Promise<Uint8Array> {
  if (!body) throw createError({ statusCode: 409, statusMessage: 'Media object body is missing.' })
  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray()
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) throw createError({ statusCode: 413, statusMessage: 'Media object exceeds the processing limit.' })
    return bytes
  }
  const chunks: Uint8Array[] = []; let total = 0
  for await (const chunk of body) { const bytes = new Uint8Array(chunk); total += bytes.byteLength; if (total > maxBytes) throw createError({ statusCode: 413, statusMessage: 'Media object exceeds the processing limit.' }); chunks.push(bytes) }
  const output = new Uint8Array(total); let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

export function mediaObjectKey(scope: MediaTenantScope, input: { kind: 'upload' | 'asset'; identity?: string; extension: string }): string {
  assertScope(scope)
  const extension = input.extension.toLowerCase().replace(/[^a-z0-9]/gu, '')
  if (!/^(?:jpg|jpeg|png|webp|avif)$/u.test(extension)) throw createError({ statusCode: 422, statusMessage: 'Media object extension is not allowlisted.' })
  const identity = (input.identity || randomUUID()).toLowerCase().replace(/[^a-z0-9-]/gu, '')
  if (identity.length < 8 || identity.length > 80) throw createError({ statusCode: 422, statusMessage: 'Media object identity is invalid.' })
  return `media/owners/${scope.ownerUserId}/projects/${scope.projectId}/${input.kind === 'upload' ? 'uploads' : 'assets'}/${identity}.${extension}`
}

type MemoryStorage = MediaStoragePort & { putUpload(scope: MediaTenantScope, objectKey: string, bytes: Uint8Array, contentType: string): Promise<void> }

export function createMemoryMediaStorage(): MemoryStorage {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; version: string }>()
  const identity = (scope: MediaTenantScope, key: string) => { assertObjectKey(scope, key); return `${scope.ownerUserId}:${scope.projectId}:${key}` }
  return {
    kind: 'memory_test',
    async writeUploadBytes(input) { objects.set(identity(input, input.objectKey), { bytes: new Uint8Array(input.bytes), contentType: input.contentType, version: sha256(input.bytes).slice(0, 24) }) },
    async putUpload(scope, objectKey, bytes, contentType) { objects.set(identity(scope, objectKey), { bytes: new Uint8Array(bytes), contentType, version: sha256(bytes).slice(0, 24) }) },
    async createUploadIntent(input) { assertObjectKey(input, input.objectKey); return { method: 'PUT', url: `memory-upload://${input.uploadId}`, expiresAt: input.expiresAt.toISOString(), requiredHeaders: { 'content-type': input.contentType, 'content-length': String(input.byteSize), 'x-amz-meta-uploadid': input.uploadId, 'x-amz-meta-ownerid': String(input.ownerUserId), 'x-amz-meta-projectid': String(input.projectId) }, cacheControl: 'private, no-store' } },
    async completeUpload(input) { const value = objects.get(identity(input, input.objectKey)); if (!value) throw createError({ statusCode: 409, statusMessage: 'Uploaded media object is missing.' }); return { byteSize: value.bytes.byteLength, contentType: value.contentType, etag: sha256(value.bytes), versionReference: value.version, metadata: { uploadid: input.uploadId, ownerid: String(input.ownerUserId), projectid: String(input.projectId) } } },
    async headObject(input) { const value = objects.get(identity(input, input.objectKey)); return value ? { byteSize: value.bytes.byteLength, contentType: value.contentType, etag: sha256(value.bytes), versionReference: value.version, metadata: {} } : null },
    async readForProcessing(input) { const value = objects.get(identity(input, input.objectKey)); if (!value) throw createError({ statusCode: 404, statusMessage: 'Media object was not found.' }); if (value.bytes.byteLength > input.maxBytes) throw createError({ statusCode: 413, statusMessage: 'Media object exceeds the processing limit.' }); return new Uint8Array(value.bytes) },
    async writeVariant(input) { const version = sha256(input.bytes).slice(0, 24); objects.set(identity(input, input.objectKey), { bytes: new Uint8Array(input.bytes), contentType: input.contentType, version }); return { objectKey: input.objectKey, byteSize: input.bytes.byteLength, sha256: sha256(input.bytes), contentType: input.contentType, versionReference: version } },
    async createSignedRead(input) { if (!objects.has(identity(input, input.objectKey))) throw createError({ statusCode: 404, statusMessage: 'Media object was not found.' }); return { method: 'GET', url: `memory-read://${sha256(Buffer.from(identity(input, input.objectKey))).slice(0, 32)}`, expiresAt: input.expiresAt.toISOString(), requiredHeaders: {}, cacheControl: 'private, no-store' } },
    async deleteObject(input) { const deleted = objects.delete(identity(input, input.objectKey)); return { deleted, receiptReference: `memory-delete:${sha256(Buffer.from(identity(input, input.objectKey))).slice(0, 32)}` } },
    async healthCheck() { return { ready: true, mode: 'deterministic-memory-test' } },
  }
}

export function createLocalDevMediaStorage(root: string): MediaStoragePort {
  if (process.env.NODE_ENV === 'production') throw createError({ statusCode: 503, statusMessage: 'Local media storage is disabled in production.' })
  const fixedRoot = resolve(root)
  const pathFor = (scope: MediaTenantScope, key: string) => { assertObjectKey(scope, key); const target = resolve(fixedRoot, key); if (!target.startsWith(`${fixedRoot}${sep}`)) throw createError({ statusCode: 403, statusMessage: 'Media object path is outside the fixed development root.' }); return target }
  return {
    kind: 'local_dev',
    async writeUploadBytes(input) { const target = pathFor(input, input.objectKey); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, input.bytes, { flag: 'wx' }) },
    async createUploadIntent(input) { const target = pathFor(input, input.objectKey); await mkdir(resolve(target, '..'), { recursive: true }); return { method: 'PUT', url: `/api/managed-sites/editor/uploads/${encodeURIComponent(input.uploadId)}/bytes`, expiresAt: input.expiresAt.toISOString(), requiredHeaders: { 'content-type': input.contentType, 'content-length': String(input.byteSize) }, cacheControl: 'private, no-store' } },
    async completeUpload(input) { const target = pathFor(input, input.objectKey); const info = await stat(target); return { byteSize: info.size, contentType: null, etag: null, versionReference: null, metadata: {} } },
    async headObject(input) { try { const info = await stat(pathFor(input, input.objectKey)); return { byteSize: info.size, contentType: null, etag: null, versionReference: null, metadata: {} } } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error } },
    async readForProcessing(input) { const bytes = await readFile(pathFor(input, input.objectKey)); if (bytes.byteLength > Math.min(input.maxBytes, MAX_PROCESSING_BYTES)) throw createError({ statusCode: 413, statusMessage: 'Media object exceeds the processing limit.' }); return bytes },
    async writeVariant(input) { const target = pathFor(input, input.objectKey); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, input.bytes, { flag: 'wx' }); return { objectKey: input.objectKey, byteSize: input.bytes.byteLength, sha256: sha256(input.bytes), contentType: input.contentType, versionReference: null } },
    async createSignedRead(input) { pathFor(input, input.objectKey); safeExpiry(input.expiresAt); const expires = input.expiresAt.getTime(); const signature = localReadSignature(fixedRoot, input, input.objectKey, expires); return { method: 'GET', url: `/api/managed-sites/editor/media/read?key=${encodeURIComponent(input.objectKey)}&expires=${expires}&signature=${signature}`, expiresAt: input.expiresAt.toISOString(), requiredHeaders: {}, cacheControl: 'private, no-store' } },
    async deleteObject(input) { try { await unlink(pathFor(input, input.objectKey)); return { deleted: true, receiptReference: `local-delete:${sha256(Buffer.from(input.objectKey)).slice(0, 32)}` } } catch (error: any) { if (error?.code === 'ENOENT') return { deleted: false, receiptReference: `local-missing:${sha256(Buffer.from(input.objectKey)).slice(0, 32)}` }; throw error } },
    async healthCheck() { try { await mkdir(fixedRoot, { recursive: true }); return { ready: true, mode: 'local-development-only' } } catch { return { ready: false, mode: 'local-development-only', reason: 'fixed_root_unavailable' } } },
  }
}

function localReadSecret(fixedRoot: string): string { const configured = process.env.NUXT_MEDIA_LOCAL_SIGNING_SECRET; if (configured && configured.length >= 32) return configured; if (process.env.NODE_ENV === 'production') throw createError({ statusCode: 503, statusMessage: 'Local media read signing is unavailable in production.' }); return sha256(Buffer.from(`development-only:${fixedRoot}`)) }
function localReadSignature(fixedRoot: string, scope: MediaTenantScope, objectKey: string, expires: number): string { assertObjectKey(scope, objectKey); return createHmac('sha256', localReadSecret(fixedRoot)).update(`${scope.ownerUserId}:${scope.projectId}:${objectKey}:${expires}`).digest('hex') }
export function verifyLocalMediaRead(input: { root: string; scope: MediaTenantScope; objectKey: string; expires: number; signature: string }, now = new Date()): void { const fixedRoot = resolve(input.root); if (!Number.isSafeInteger(input.expires) || input.expires <= now.getTime() || input.expires - now.getTime() > 900_000 || !/^[a-f0-9]{64}$/u.test(input.signature)) throw createError({ statusCode: 403, statusMessage: 'Local media read authorization is invalid or expired.' }); const expected = localReadSignature(fixedRoot, input.scope, input.objectKey, input.expires); if (!timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature))) throw createError({ statusCode: 403, statusMessage: 'Local media read authorization is invalid or expired.' }) }

export interface S3MediaConfiguration { bucket: string; region: string; prefix: string; endpoint?: string; credentialReference: string; publicCdnOrigin?: string }
function validateS3Configuration(input: S3MediaConfiguration): S3MediaConfiguration {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(input.bucket) || !/^[a-z0-9-]{3,32}$/u.test(input.region) || !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$/u.test(input.prefix) || input.prefix.includes('..') || !/^[A-Z][A-Z0-9_]{7,159}$/u.test(input.credentialReference)) throw createError({ statusCode: 503, statusMessage: 'S3-compatible media storage configuration is invalid.' })
  for (const raw of [input.endpoint, input.publicCdnOrigin].filter(Boolean) as string[]) {
    let url: URL; try { url = new URL(assertPublicHttpsUrl(raw, 'Media storage origin')) } catch { throw createError({ statusCode: 503, statusMessage: 'Media storage origin is invalid.' }) }
    if (url.pathname !== '/' || url.search || url.hash) throw createError({ statusCode: 503, statusMessage: 'Media storage origin is not an approved fixed HTTPS authority.' })
  }
  return { ...input, prefix: input.prefix.replace(/\/$/u, '') }
}
function configuredKey(configuration: S3MediaConfiguration, scope: MediaTenantScope, key: string): string { assertObjectKey(scope, key); return `${configuration.prefix}/${key}` }
export function createS3MediaStorage(options: { configuration: S3MediaConfiguration; client?: Pick<S3Client, 'send'>; presign?: typeof getSignedUrl }): MediaStoragePort {
  if (!/^[A-Z][A-Z0-9_]{7,159}$/u.test(options.configuration.credentialReference)) throw createError({ statusCode: 503, statusMessage: 'S3-compatible media storage configuration is invalid.' })
  const rawCredential = process.env[options.configuration.credentialReference]
  let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  try { const parsed = rawCredential ? JSON.parse(rawCredential) : null; if (!parsed || typeof parsed.accessKeyId !== 'string' || typeof parsed.secretAccessKey !== 'string') throw new Error('missing'); credentials = { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey, ...(typeof parsed.sessionToken === 'string' ? { sessionToken: parsed.sessionToken } : {}) } } catch { throw createError({ statusCode: 503, statusMessage: 'S3-compatible media storage credential reference is unresolved.' }) }
  const configuration = validateS3Configuration(options.configuration)
  const client = options.client || new S3Client({ region: configuration.region, credentials, ...(configuration.endpoint ? { endpoint: configuration.endpoint, forcePathStyle: true } : {}) })
  const presign = options.presign || getSignedUrl
  return {
    kind: 's3_compatible',
    async createUploadIntent(input) { const expiresIn = safeExpiry(input.expiresAt); const key = configuredKey(configuration, input, input.objectKey); const metadataHeaders = ['x-amz-meta-uploadid', 'x-amz-meta-ownerid', 'x-amz-meta-projectid']; const command = new PutObjectCommand({ Bucket: configuration.bucket, Key: key, ContentType: input.contentType, ContentLength: input.byteSize, Metadata: { uploadid: input.uploadId, ownerid: String(input.ownerUserId), projectid: String(input.projectId) } }); const url = await presign(client as S3Client, command, { expiresIn, signableHeaders: new Set(['content-length', 'content-type', ...metadataHeaders]), unhoistableHeaders: new Set(metadataHeaders) }); return { method: 'PUT', url, expiresAt: input.expiresAt.toISOString(), requiredHeaders: { 'content-type': input.contentType, 'content-length': String(input.byteSize), 'x-amz-meta-uploadid': input.uploadId, 'x-amz-meta-ownerid': String(input.ownerUserId), 'x-amz-meta-projectid': String(input.projectId) }, cacheControl: 'private, no-store' } },
    async completeUpload(input) { const response = await client.send(new HeadObjectCommand({ Bucket: configuration.bucket, Key: configuredKey(configuration, input, input.objectKey) })) as any; return { byteSize: Number(response.ContentLength || 0), contentType: response.ContentType || null, etag: typeof response.ETag === 'string' ? response.ETag.replace(/["']/gu, '') : null, versionReference: response.VersionId || null, metadata: response.Metadata || {} } },
    async headObject(input) { const key = configuredKey(configuration, input, input.objectKey); try { const response = await client.send(new HeadObjectCommand({ Bucket: configuration.bucket, Key: key })) as any; return { byteSize: Number(response.ContentLength || 0), contentType: response.ContentType || null, etag: typeof response.ETag === 'string' ? response.ETag.replace(/["']/gu, '') : null, versionReference: response.VersionId || null, metadata: response.Metadata || {} } } catch (error: any) { if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null; throw createError({ statusCode: 503, statusMessage: 'Media storage lookup failed.' }) } },
    async readForProcessing(input) { const response = await client.send(new GetObjectCommand({ Bucket: configuration.bucket, Key: configuredKey(configuration, input, input.objectKey), Range: `bytes=0-${Math.min(input.maxBytes, MAX_PROCESSING_BYTES)}` })) as any; return boundedBody(response.Body, Math.min(input.maxBytes, MAX_PROCESSING_BYTES)) },
    async writeVariant(input) { const response = await client.send(new PutObjectCommand({ Bucket: configuration.bucket, Key: configuredKey(configuration, input, input.objectKey), Body: input.bytes, ContentType: input.contentType, ContentLength: input.bytes.byteLength, CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha256: input.sha256 } })) as any; return { objectKey: input.objectKey, byteSize: input.bytes.byteLength, sha256: input.sha256, contentType: input.contentType, versionReference: response.VersionId || response.ETag?.replace(/["']/gu, '') || null } },
    async createSignedRead(input) { const expiresIn = safeExpiry(input.expiresAt); const url = await presign(client as S3Client, new GetObjectCommand({ Bucket: configuration.bucket, Key: configuredKey(configuration, input, input.objectKey), ResponseCacheControl: 'private, no-store' }), { expiresIn }); return { method: 'GET', url, expiresAt: input.expiresAt.toISOString(), requiredHeaders: {}, cacheControl: 'private, no-store' } },
    async deleteObject(input) { const response = await client.send(new DeleteObjectCommand({ Bucket: configuration.bucket, Key: configuredKey(configuration, input, input.objectKey) })) as any; return { deleted: true, receiptReference: `s3-delete:${String(response.VersionId || response.DeleteMarker || sha256(Buffer.from(input.objectKey))).replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 200)}` } },
    async healthCheck() { try { const response = await client.send(new HeadBucketCommand({ Bucket: configuration.bucket })) as any; const status = Number(response?.$metadata?.httpStatusCode || 200); if (status >= 200 && status < 300) return { ready: true, mode: 's3-compatible-verified' }; return { ready: false, mode: 's3-compatible-blocked', reason: `health_status_${status}` } } catch { return { ready: false, mode: 's3-compatible-blocked', reason: 'health_request_failed' } } },
  }
}

export function resolveProductionMediaStorage(configuration?: S3MediaConfiguration): MediaStoragePort {
  if (configuration) return createS3MediaStorage({ configuration })
  throw createError({ statusCode: 503, statusMessage: 'Production media storage is not configured.' })
}
