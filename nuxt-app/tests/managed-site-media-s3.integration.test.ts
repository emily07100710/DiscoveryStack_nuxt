import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryMediaVaultRepository } from '../server/managed-sites/media-vault/memory-repository'
import { completeMediaUpload, permanentlyDeleteMediaAsset, requestMediaUploadIntent, trashMediaAsset } from '../server/managed-sites/media-vault/service'
import { createS3MediaStorage } from '../server/managed-sites/media-vault/storage'
import { createDeterministicTestImageProcessor, createPassingTestScanner, hashBytes } from '../server/managed-sites/media-vault/validation'
import type { MediaActor } from '../server/managed-sites/media-vault/types'

const enabled = process.env.DS_RUN_MEDIA_S3_INTEGRATION === '1'
const suite = enabled ? describe : describe.skip
const endpoint = process.env.DS_MEDIA_S3_ENDPOINT || ''
const bucket = process.env.DS_MEDIA_S3_BUCKET || `discoverystack-media-${process.pid}`
const accessKeyId = process.env.DS_MEDIA_S3_ACCESS_KEY || 'discoverystack'
const secretAccessKey = process.env.DS_MEDIA_S3_SECRET_KEY || 'discoverystack-fixture-secret'
const actor: MediaActor = { ownerUserId: 1, projectId: 10, actorUserId: 99, authority: 'customer_session', role: 'customer_admin' }
let client: S3Client

function png(suffix: string): Uint8Array {
  const bytes = Buffer.alloc(40 + suffix.length)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  Buffer.from('IHDR').copy(bytes, 12)
  bytes.writeUInt32BE(1200, 16)
  bytes.writeUInt32BE(800, 20)
  Buffer.from(suffix).copy(bytes, 40)
  return bytes
}

suite('managed-site media disposable S3-compatible integration', () => {
  beforeAll(async () => {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(endpoint)) throw new Error('A disposable loopback S3 endpoint is required.')
    process.env.DS_MEDIA_S3_TEST_CREDENTIAL = JSON.stringify({ accessKeyId, secretAccessKey })
    client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  }, 30_000)

  afterAll(async () => {
    try { await client?.send(new DeleteBucketCommand({ Bucket: bucket })) } catch { /* disposable container teardown owns final cleanup */ }
    delete process.env.DS_MEDIA_S3_TEST_CREDENTIAL
    client?.destroy()
  })

  it('performs signed upload, exact head, rejected-upload cleanup, signed read and recoverable deletion', async () => {
    const repository = createMemoryMediaVaultRepository()
    const storage = createS3MediaStorage({
      configuration: { bucket, region: 'us-east-1', prefix: 'integration', credentialReference: 'DS_MEDIA_S3_TEST_CREDENTIAL' },
      client,
    })
    expect(await storage.healthCheck()).toMatchObject({ ready: true, mode: 's3-compatible-verified' })
    const rejectedBytes = png('rejected')
    const rejectedIntent = await requestMediaUploadIntent({ repository, storage }, actor, { filename: 'rejected.png', declaredMime: 'image/png', declaredBytes: rejectedBytes.byteLength, visibility: 'private', idempotencyKey: 's3-rejected-upload-001' })
    const rejectedAuthorization = rejectedIntent.authorization
    expect(new URL(rejectedAuthorization.url).searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(expect.arrayContaining(Object.keys(rejectedAuthorization.requiredHeaders)))
    const rejectedPut = await fetch(rejectedAuthorization.url, { method: 'PUT', headers: rejectedAuthorization.requiredHeaders, body: Buffer.from(rejectedBytes) })
    expect(rejectedPut.ok, `MinIO PUT ${rejectedPut.status}: ${await rejectedPut.text()}`).toBe(true)
    await expect(completeMediaUpload({ repository, storage, scanner: createPassingTestScanner(), processor: createDeterministicTestImageProcessor() }, actor, { uploadId: rejectedIntent.session.uploadId, expectedSha256: '0'.repeat(64) })).rejects.toThrow(/hash/i)
    expect(await storage.headObject({ ...actor, objectKey: rejectedIntent.session.objectKey })).toBeNull()

    const acceptedBytes = png('accepted')
    const acceptedIntent = await requestMediaUploadIntent({ repository, storage }, actor, { filename: 'accepted.png', declaredMime: 'image/png', declaredBytes: acceptedBytes.byteLength, visibility: 'private', idempotencyKey: 's3-accepted-upload-001' })
    const acceptedPut = await fetch(acceptedIntent.authorization.url, { method: 'PUT', headers: acceptedIntent.authorization.requiredHeaders, body: Buffer.from(acceptedBytes) })
    expect(acceptedPut.ok, `MinIO PUT ${acceptedPut.status}: ${await acceptedPut.text()}`).toBe(true)
    const accepted = await completeMediaUpload({ repository, storage, scanner: createPassingTestScanner(), processor: createDeterministicTestImageProcessor() }, actor, { uploadId: acceptedIntent.session.uploadId, expectedSha256: hashBytes(acceptedBytes) })
    expect(await storage.headObject({ ...actor, objectKey: accepted.asset.originalObjectKey })).toMatchObject({ byteSize: acceptedBytes.byteLength, contentType: 'image/png' })
    const signedRead = await storage.createSignedRead({ ...actor, objectKey: accepted.asset.originalObjectKey, expiresAt: new Date(Date.now() + 60_000) })
    const read = await fetch(signedRead.url)
    expect(read.status).toBe(200)
    expect(Buffer.from(await read.arrayBuffer())).toEqual(Buffer.from(acceptedBytes))
    await expect(storage.headObject({ ownerUserId: 2, projectId: 20, objectKey: accepted.asset.originalObjectKey })).rejects.toMatchObject({ statusCode: 403 })

    await trashMediaAsset(repository, actor, accepted.asset.assetId, new Date('2026-07-01T00:00:00Z'))
    const unavailable = { ...storage, async deleteObject() { throw new Error('injected one-attempt S3 outage') } }
    await expect(permanentlyDeleteMediaAsset({ repository, storage: unavailable }, actor, { assetId: accepted.asset.assetId, confirmation: `DELETE:${accepted.asset.assetId}` }, new Date('2026-08-02T00:00:00Z'))).rejects.toMatchObject({ statusCode: 503 })
    expect(await repository.findAsset(actor, accepted.asset.assetId)).toMatchObject({ status: 'deletion_pending' })
    const recovered = await permanentlyDeleteMediaAsset({ repository, storage }, actor, { assetId: accepted.asset.assetId, confirmation: `DELETE:${accepted.asset.assetId}` }, new Date('2026-08-02T00:00:00Z'))
    expect(recovered.asset).toMatchObject({ status: 'deleted' })
    expect(await storage.headObject({ ...actor, objectKey: accepted.asset.originalObjectKey })).toBeNull()
  }, 60_000)
})
