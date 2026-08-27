import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import type { ManagedSiteArtifactVault } from './generation-service'

type VaultConfiguration = { bucket: string; region: string; prefix: string; endpoint?: string }

function configurationFromRuntime(): VaultConfiguration {
  const raw = process.env.DISCOVERYSTACK_MANAGED_SITE_VAULT_JSON
  let parsed: unknown
  try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw createError({ statusCode: 503, statusMessage: 'Managed-site owner artifact vault configuration is unavailable.' })
  const value = parsed as Record<string, unknown>
  if (typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value.bucket) || typeof value.region !== 'string' || !/^[a-z0-9-]{3,32}$/u.test(value.region) || typeof value.prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$/u.test(value.prefix) || value.prefix.includes('..')) throw createError({ statusCode: 503, statusMessage: 'Managed-site owner artifact vault configuration is invalid.' })
  if (value.endpoint !== undefined && (typeof value.endpoint !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/u.test(value.endpoint))) throw createError({ statusCode: 503, statusMessage: 'Managed-site owner artifact vault endpoint is invalid.' })
  return { bucket: value.bucket, region: value.region, prefix: value.prefix.replace(/\/$/u, ''), ...(value.endpoint ? { endpoint: value.endpoint } : {}) }
}

function responseIdentity(value: { VersionId?: string; ETag?: string }, bundleHash: string): string {
  const source = value.VersionId || value.ETag?.replace(/["']/gu, '') || bundleHash
  return `s3-object:${String(source).replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 220)}`
}

const MAX_VAULT_BUNDLE_BYTES = 2_500_000

function objectKey(configuration: VaultConfiguration, input: { ownerUserId: number; projectId: number; requestFingerprint: string }): string {
  return `${configuration.prefix}/owners/${input.ownerUserId}/projects/${input.projectId}/candidates/${input.requestFingerprint}.json`
}

function notFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return candidate?.name === 'NotFound' || candidate?.name === 'NoSuchKey' || candidate?.$metadata?.httpStatusCode === 404
}

async function boundedObjectBody(body: any): Promise<string> {
  if (!body) throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object body is missing.' })
  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray()
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_VAULT_BUNDLE_BYTES) throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object is oversized.' })
    return Buffer.from(bytes).toString('utf8')
  }
  const chunks: Buffer[] = []; let total = 0
  if (typeof body === 'string' || body instanceof Uint8Array) {
    const bytes = Buffer.from(body); if (bytes.byteLength > MAX_VAULT_BUNDLE_BYTES) throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object is oversized.' }); return bytes.toString('utf8')
  }
  if (!body[Symbol.asyncIterator]) throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object body is unsupported.' })
  for await (const chunk of body) { const bytes = Buffer.from(chunk); total += bytes.byteLength; if (total > MAX_VAULT_BUNDLE_BYTES) throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object is oversized.' }); chunks.push(bytes) }
  return Buffer.concat(chunks).toString('utf8')
}

export function createS3ManagedSiteArtifactVault(options: { configuration?: VaultConfiguration; client?: Pick<S3Client, 'send'> } = {}): ManagedSiteArtifactVault {
  const configuration = options.configuration || configurationFromRuntime()
  const client = options.client || new S3Client({ region: configuration.region, ...(configuration.endpoint ? { endpoint: configuration.endpoint } : {}) })
  return {
    async lookupImmutableCandidate(input) {
      const key = objectKey(configuration, input)
      let head: { VersionId?: string; ETag?: string; ContentLength?: number; Metadata?: Record<string, string> }
      try { head = await client.send(new HeadObjectCommand({ Bucket: configuration.bucket, Key: key })) as typeof head } catch (error) { if (notFound(error)) return null; throw createError({ statusCode: 503, statusMessage: 'Managed-site owner vault lookup failed.' }) }
      if (Number(head.ContentLength || 0) > MAX_VAULT_BUNDLE_BYTES) throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object is oversized.' })
      let object: { VersionId?: string; ETag?: string; Body?: unknown; Metadata?: Record<string, string> }
      try { object = await client.send(new GetObjectCommand({ Bucket: configuration.bucket, Key: key })) as typeof object } catch { throw createError({ statusCode: 503, statusMessage: 'Managed-site owner vault read failed.' }) }
      const raw = await boundedObjectBody(object.Body)
      let bundle: unknown
      try { bundle = JSON.parse(raw) } catch { throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object is malformed.' }) }
      const bundleHash = stableFingerprint(bundle)
      if (head.Metadata?.bundlehash !== bundleHash || object.Metadata?.bundlehash && object.Metadata.bundlehash !== bundleHash) throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object metadata hash is mismatched.' })
      return { bundle, vaultReference: `vault:s3:${input.ownerUserId}:${input.projectId}:${input.requestFingerprint}`, exactResponseIdentity: responseIdentity(object, bundleHash) }
    },
    async storeImmutableCandidate(input) {
      const body = JSON.stringify(input)
      const bundleHash = stableFingerprint(input)
      if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_BUNDLE_BYTES) throw createError({ statusCode: 422, statusMessage: 'Managed-site owner vault bundle exceeds the fixed storage limit.' })
      const key = objectKey(configuration, input)
      let response: { VersionId?: string; ETag?: string }
      try {
        response = await client.send(new PutObjectCommand({ Bucket: configuration.bucket, Key: key, Body: body, ContentType: 'application/json', ServerSideEncryption: 'AES256', IfNoneMatch: '*', Metadata: { contenthash: input.manifest.contentHash, manifesthash: input.manifest.manifestHash, bundlehash: bundleHash, requestfingerprint: input.requestFingerprint } })) as { VersionId?: string; ETag?: string }
      } catch (error) {
        const status = Number((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode)
        if (status !== 409 && status !== 412) throw createError({ statusCode: 503, statusMessage: 'Managed-site owner vault write failed without storing an accepted candidate.' })
        const existing = await client.send(new HeadObjectCommand({ Bucket: configuration.bucket, Key: key })) as { VersionId?: string; ETag?: string; Metadata?: Record<string, string> }
        if (existing.Metadata?.contenthash !== input.manifest.contentHash || existing.Metadata?.manifesthash !== input.manifest.manifestHash || existing.Metadata?.bundlehash !== bundleHash) throw createError({ statusCode: 409, statusMessage: 'Managed-site owner vault object identity collided with different content.' })
        response = existing
      }
      return { vaultReference: `vault:s3:${input.ownerUserId}:${input.projectId}:${input.requestFingerprint}`, contentHash: input.manifest.contentHash, exactResponseIdentity: responseIdentity(response, bundleHash) }
    },
  }
}
