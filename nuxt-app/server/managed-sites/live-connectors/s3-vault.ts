import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
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

export function createS3ManagedSiteArtifactVault(options: { configuration?: VaultConfiguration; client?: Pick<S3Client, 'send'> } = {}): ManagedSiteArtifactVault {
  const configuration = options.configuration || configurationFromRuntime()
  const client = options.client || new S3Client({ region: configuration.region, ...(configuration.endpoint ? { endpoint: configuration.endpoint } : {}) })
  return {
    async storeImmutableCandidate(input) {
      const bundle = { schemaVersion: 'managed-site-owner-vault-bundle-v1', ownerUserId: input.ownerUserId, projectId: input.projectId, requestFingerprint: input.requestFingerprint, manifest: input.manifest, files: input.files }
      const body = JSON.stringify(bundle)
      const bundleHash = stableFingerprint(bundle)
      if (Buffer.byteLength(body, 'utf8') > 2_500_000) throw createError({ statusCode: 422, statusMessage: 'Managed-site owner vault bundle exceeds the fixed storage limit.' })
      const key = `${configuration.prefix}/owners/${input.ownerUserId}/projects/${input.projectId}/candidates/${input.requestFingerprint}.json`
      let response: { VersionId?: string; ETag?: string }
      try {
        response = await client.send(new PutObjectCommand({ Bucket: configuration.bucket, Key: key, Body: body, ContentType: 'application/json', ServerSideEncryption: 'AES256', IfNoneMatch: '*', Metadata: { contenthash: input.manifest.contentHash, manifesthash: input.manifest.manifestHash, bundlehash: bundleHash } })) as { VersionId?: string; ETag?: string }
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
