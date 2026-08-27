import { describe, expect, it, vi } from 'vitest'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { createS3ManagedSiteArtifactVault } from '../server/managed-sites/live-connectors/s3-vault'
import { stableFingerprint } from '../server/seo-geo-core/repository'

describe('managed-site owner artifact vault boundary', () => {
  it('stores one immutable encrypted-at-rest bundle and returns only an opaque reference', async () => {
    const send = vi.fn().mockResolvedValue({ ETag: '"synthetic-etag"' })
    const vault = createS3ManagedSiteArtifactVault({ configuration: { bucket: 'managed-artifacts-test', region: 'ap-east-1', prefix: 'managed-sites' }, client: { send } as any })
    const content = '<html><body>Managed candidate</body></html>'
    const fileHash = stableFingerprint({ content })
    const manifest = { schemaVersion: 'managed-site-generation-manifest-v1' as const, files: [{ path: 'src/pages/index.astro', mediaType: 'text/astro' as const, byteSize: Buffer.byteLength(content), sha256: fileHash }], fileCount: 1, totalBytes: Buffer.byteLength(content), contentHash: stableFingerprint({ fileHash }), manifestHash: stableFingerprint({ manifest: fileHash }) }
    const result = await vault.storeImmutableCandidate({ schemaVersion: 'managed-site-owner-vault-bundle-v2', ownerUserId: 7, projectId: 11, requestFingerprint: 'a'.repeat(64), providerOutput: {} as any, blueprint: {} as any, blueprintHash: 'd'.repeat(64), compilerFingerprint: 'e'.repeat(64), manifest, files: [{ path: 'src/pages/index.astro', mediaType: 'text/astro', content, sha256: fileHash }] })
    expect(result.vaultReference).toBe(`vault:s3:7:11:${'a'.repeat(64)}`)
    expect(result).not.toHaveProperty('bucket')
    expect(result).not.toHaveProperty('key')
    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0]![0]
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command.input).toMatchObject({ Bucket: 'managed-artifacts-test', ServerSideEncryption: 'AES256', IfNoneMatch: '*', ContentType: 'application/json' })
    expect(String(command.input.Key)).toContain('/owners/7/projects/11/candidates/')
  })

  it('fails closed when an immutable object key already contains different identity metadata', async () => {
    const conflict = Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } })
    const send = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ Metadata: { contenthash: 'different', manifesthash: 'different', bundlehash: 'different' } })
    const vault = createS3ManagedSiteArtifactVault({ configuration: { bucket: 'managed-artifacts-test', region: 'ap-east-1', prefix: 'managed-sites' }, client: { send } as any })
    const manifest = { schemaVersion: 'managed-site-generation-manifest-v1' as const, files: [], fileCount: 0, totalBytes: 0, contentHash: 'b'.repeat(64), manifestHash: 'c'.repeat(64) }
    await expect(vault.storeImmutableCandidate({ schemaVersion: 'managed-site-owner-vault-bundle-v2', ownerUserId: 7, projectId: 11, requestFingerprint: 'd'.repeat(64), providerOutput: {} as any, blueprint: {} as any, blueprintHash: 'e'.repeat(64), compilerFingerprint: 'f'.repeat(64), manifest, files: [] })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('heads and reads the exact immutable candidate with a bounded body and matching metadata identity', async () => {
    const requestFingerprint = 'a'.repeat(64); const bundle = { schemaVersion: 'managed-site-owner-vault-bundle-v2', ownerUserId: 7, projectId: 11, requestFingerprint, providerOutput: {}, blueprint: {}, blueprintHash: 'b'.repeat(64), compilerFingerprint: 'c'.repeat(64), manifest: { contentHash: 'd'.repeat(64), manifestHash: 'e'.repeat(64) }, files: [] }
    const raw = JSON.stringify(bundle); const bundleHash = stableFingerprint(bundle)
    const send = vi.fn(async (command: any) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: Buffer.byteLength(raw), Metadata: { bundlehash: bundleHash }, ETag: 'head-etag' }
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new TextEncoder().encode(raw) }, Metadata: { bundlehash: bundleHash }, ETag: 'get-etag' }
      throw new Error('unexpected command')
    })
    const vault = createS3ManagedSiteArtifactVault({ configuration: { bucket: 'managed-artifacts-test', region: 'ap-east-1', prefix: 'managed-sites' }, client: { send } as any })
    const recovered = await vault.lookupImmutableCandidate({ ownerUserId: 7, projectId: 11, requestFingerprint })
    expect(recovered?.bundle).toEqual(bundle); expect(recovered?.vaultReference).toBe(`vault:s3:7:11:${requestFingerprint}`)
    expect(send.mock.calls.map(call => call[0].constructor)).toEqual([HeadObjectCommand, GetObjectCommand])
  })

  it.each([
    ['oversized head', 2_500_001, JSON.stringify({}), 'a'.repeat(64)],
    ['oversized GetObject body', 1, 'x'.repeat(2_500_001), 'a'.repeat(64)],
    ['tampered object metadata', 2, '{}', 'b'.repeat(64)],
  ])('fails closed on %s before returning a vault authority', async (_label, contentLength, raw, metadataHash) => {
    const send = vi.fn(async (command: any) => command instanceof HeadObjectCommand
      ? { ContentLength: contentLength, Metadata: { bundlehash: metadataHash } }
      : { Body: { transformToByteArray: async () => new TextEncoder().encode(raw) }, Metadata: { bundlehash: metadataHash } })
    const vault = createS3ManagedSiteArtifactVault({ configuration: { bucket: 'managed-artifacts-test', region: 'ap-east-1', prefix: 'managed-sites' }, client: { send } as any })
    await expect(vault.lookupImmutableCandidate({ ownerUserId: 7, projectId: 11, requestFingerprint: 'f'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 })
  })
})
