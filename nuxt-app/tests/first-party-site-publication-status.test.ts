import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  checkFirstPartySitePublication,
  normalizeSitePublicationObservation,
  SITE_PUBLICATION_STATUS_PATH,
  SITE_PUBLICATION_STATUS_VERSION,
  type SitePublicationStatusQuery,
} from '../server/first-party-publishing/site-publication-status'
import type { FirstPartyFetch, FirstPartyFetchResponse, FirstPartyPublishTarget, FirstPartyRequestInit } from '../server/first-party-publishing/types'

const secret = 'synthetic-only-status-key-00000000000000000000000000000000'
const timestamp = '2026-10-08T02:00:00.000Z'
const nonce = 'synthetic-status-nonce-0001'
const origin = 'https://site.example.com'
const query: SitePublicationStatusQuery = {
  publicationId: 'destination-abc123',
  contentHash: 'a'.repeat(64),
  postId: 'post-12345678',
}
const target: FirstPartyPublishTarget = {
  targetId: 'target-12345678', ownerScopeKey: 'owner-scope-12345678',
  framework: 'nextjs', transport: 'first_party_signed_api', targetOrigin: origin,
  contentRoot: 'content', defaultBranch: 'main', repositoryOwner: null, repositoryName: null,
  endpointPath: '/api/first-party/content-ingest', credentialReference: 'hmac-key:synthetic-only',
  status: 'active', allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'],
  maximumPayloadBytes: 4096, executionEnabled: true,
}
const deps = (fetchImpl: FirstPartyFetch) => ({
  fetchImpl,
  serverCredentialResolver: vi.fn(async () => ({ ok: true as const, value: secret })),
  nonceProvider: vi.fn(() => nonce),
  now: new Date(timestamp),
})

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function mac(fields: readonly string[]): string { return createHmac('sha256', secret).update(fields.join('\n'), 'utf8').digest('hex') }

function observation(overrides: Record<string, unknown> = {}) {
  return {
    version: SITE_PUBLICATION_STATUS_VERSION,
    targetId: target.targetId,
    targetOrigin: origin,
    publicationId: query.publicationId,
    contentHash: query.contentHash,
    postId: query.postId,
    receiptScope: 'site_publication_observation',
    receiptIsCurrentState: false,
    state: 'published',
    postVersion: 2,
    publishedVersion: 2,
    receivedDocumentHash: 'b'.repeat(64),
    publishedDocumentHash: 'b'.repeat(64),
    hasUnpublishedChanges: false,
    publishedAt: '2026-10-08T01:59:00.000Z',
    observedAt: timestamp,
    nonce,
    ...overrides,
  }
}

function signedResponse(payload: unknown, options: { status?: number; responseNonce?: string; rawResponse?: string; headers?: Record<string, string> } = {}) {
  const request = {
    version: SITE_PUBLICATION_STATUS_VERSION,
    targetId: target.targetId,
    ownerScopeKey: target.ownerScopeKey,
    publicationId: query.publicationId,
    contentHash: query.contentHash,
    postId: query.postId,
    timestamp,
    nonce,
  }
  const rawRequest = JSON.stringify(request)
  const rawResponse = options.rawResponse ?? JSON.stringify(payload)
  const responseNonce = options.responseNonce ?? nonce
  const responseSignature = mac([
    SITE_PUBLICATION_STATUS_VERSION, 'response', 'POST', SITE_PUBLICATION_STATUS_PATH, origin,
    hash(rawRequest), hash(rawResponse), timestamp, responseNonce,
  ])
  const result: FirstPartyFetchResponse = {
    status: options.status ?? 200,
    headers: { 'x-ds-status-signature': responseSignature, ...options.headers },
    text: async () => rawResponse,
  }
  return { result, request, rawRequest, rawResponse }
}

function run(payload: unknown, options: Parameters<typeof signedResponse>[1] = {}, destination = target) {
  const signed = signedResponse(payload, options)
  const fetchImpl = vi.fn(async (_url: string, _init: FirstPartyRequestInit) => signed.result)
  const dependencies = deps(fetchImpl)
  return { result: checkFirstPartySitePublication(query, destination, dependencies), fetchImpl, dependencies, signed }
}

describe('signed read-only first-party publication status', () => {
  it('POSTs only the fixed target-bound status endpoint and returns an authenticated observation fingerprint', async () => {
    const { result, fetchImpl, dependencies, signed } = run(observation())
    await expect(result).resolves.toMatchObject({ status: 'verified', observation: { state: 'published', documentState: 'in_sync' }, responseFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(`${origin}${SITE_PUBLICATION_STATUS_PATH}`, expect.objectContaining({
      method: 'POST', redirect: 'manual', body: signed.rawRequest,
      headers: expect.objectContaining({ 'content-type': 'application/json', 'x-ds-status-signature': expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    }))
    expect(JSON.parse(signed.rawRequest)).toEqual({ ...signed.request, version: SITE_PUBLICATION_STATUS_VERSION })
    expect(fetchImpl.mock.calls[0]?.[1].headers['x-ds-status-signature']).toBe(mac([
      SITE_PUBLICATION_STATUS_VERSION, 'request', 'POST', SITE_PUBLICATION_STATUS_PATH, origin,
      hash(signed.rawRequest), timestamp, nonce,
    ]))
    expect(dependencies.serverCredentialResolver).toHaveBeenCalledOnce()
  })

  it('marks a published version with unpublished edits as changed without equating source Markdown to document hashes', async () => {
    const responseValue = observation({ postVersion: 3, publishedVersion: 2, receivedDocumentHash: 'c'.repeat(64), publishedDocumentHash: 'b'.repeat(64), hasUnpublishedChanges: true })
    const { result } = run(responseValue)
    await expect(result).resolves.toMatchObject({ status: 'verified', observation: { documentState: 'changed', postVersion: 3, publishedVersion: 2 } })
  })

  it('retains the legacy unknown received hash as unverifiable rather than rejecting the observation', async () => {
    const { result } = run(observation({ receivedDocumentHash: null }))
    await expect(result).resolves.toMatchObject({ status: 'verified', observation: { documentState: 'unverifiable' } })
  })

  it('allows an unknown historical publication timestamp without inventing one', async () => {
    const { result } = run(observation({ publishedAt: null }))
    await expect(result).resolves.toMatchObject({ status: 'verified', observation: { publishedAt: null } })
  })

  it('normalizes private and archived states without inventing a publication version', async () => {
    for (const state of ['private', 'archived']) {
      const { result } = run(observation({ state, publishedVersion: null, publishedDocumentHash: null, publishedAt: null, hasUnpublishedChanges: false }))
      await expect(result).resolves.toMatchObject({ status: 'verified', observation: { state, documentState: 'not_published', publishedVersion: null } })
    }
  })

  it.each([
    ['bad signature', observation(), { headers: { 'x-ds-status-signature': '0'.repeat(64) } }],
    ['nonce replay mismatch', observation(), { responseNonce: 'synthetic-other-nonce-0001' }],
    ['response identity mismatch', observation({ postId: 'other-post-1234' }), {}],
    ['response content query mismatch', observation({ contentHash: 'd'.repeat(64) }), {}],
    ['target origin mismatch', observation({ targetOrigin: 'https://other.example.com' }), {}],
    ['unbounded future observation time', observation({ observedAt: '2026-10-08T02:06:00.000Z' }), {}],
    ['version contradiction', observation({ publishedVersion: 3, postVersion: 2 }), {}],
    ['publication timestamp after observation', observation({ publishedAt: '2026-10-08T02:01:00.000Z' }), {}],
    ['unknown response field', { ...observation(), deleted: true }, {}],
  ])('rejects %s without returning a verified projection', async (_name, payload, options) => {
    const { result } = run(payload, options)
    await expect(result).resolves.toMatchObject({ status: 'blocked' })
  })

  it('rejects wrong target types, inactive/revoked targets, and invalid input before credentials or fetch', async () => {
    for (const destination of [
      { ...target, framework: 'nuxt' as const },
      { ...target, status: 'paused' as const },
      { ...target, status: 'revoked' as const },
      { ...target, executionEnabled: false },
    ]) {
      const fetchImpl = vi.fn()
      const dependencies = deps(fetchImpl)
      const result = await checkFirstPartySitePublication(query, destination, dependencies)
      expect(result).toMatchObject({ status: 'blocked' })
      expect(dependencies.serverCredentialResolver).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    }
    const fetchImpl = vi.fn()
    const dependencies = deps(fetchImpl)
    await expect(checkFirstPartySitePublication({ ...query, postId: '' }, target, dependencies)).resolves.toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
    expect(dependencies.serverCredentialResolver).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires HTTP 200 and rejects oversized responses and non-redirecting fetch failures', async () => {
    await expect(run(observation(), { status: 302 }).result).resolves.toMatchObject({ status: 'blocked', code: 'REMOTE_UNAVAILABLE' })
    const oversized = ' '.repeat(4097)
    const result = checkFirstPartySitePublication(query, target, {
      ...deps(vi.fn()), fetchImpl: vi.fn(async () => ({ status: 200, headers: { 'x-ds-status-signature': '0'.repeat(64) }, text: async () => oversized })),
    })
    await expect(result).resolves.toMatchObject({ status: 'blocked', code: 'RESPONSE_TOO_LARGE' })
  })

  it('normalizer is exact, defensive, and only compares received to published document hashes', () => {
    expect(normalizeSitePublicationObservation(observation())).toMatchObject({ documentState: 'in_sync' })
    expect(normalizeSitePublicationObservation({ ...observation(), unknown: true })).toBeNull()
    expect(normalizeSitePublicationObservation({ ...observation(), hasUnpublishedChanges: true })).toBeNull()
    const hostileToString = vi.fn(() => 'published')
    expect(normalizeSitePublicationObservation({ ...observation(), state: { toString: hostileToString } })).toBeNull()
    expect(hostileToString).not.toHaveBeenCalled()
    expect(normalizeSitePublicationObservation({ ...observation(), nonce: 'bad' })).toBeNull()
    expect(normalizeSitePublicationObservation(new Proxy({}, { ownKeys: () => { throw new Error('synthetic') } }))).toBeNull()
    const getter = { ...observation(), get state() { throw new Error('synthetic') } }
    expect(normalizeSitePublicationObservation(getter)).toBeNull()
  })
})
