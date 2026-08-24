import { describe, expect, it, vi } from 'vitest'
import { buildSignedApiSignature, executeFirstPartyPublication, executeGitContentsPublish, executeSignedApiPublish, planFirstPartyPublication } from '../server/first-party-publishing'
import { validateFirstPartyPublishTarget } from '../server/first-party-publishing/target-guard'
import { makePublication, makeSignedTarget, makeTarget, response, signedResponse, textResponse, gitCreateResponse, gitFileResponse, gitUpdateResponse, FIXTURE_NOW, sha256 } from './fixtures/first-party-publishing/fixtures'
import type { FirstPartyFetch, FirstPartyPublishTarget } from '../server/first-party-publishing'

const MOCK_CREDENTIAL = 'fixture-key-material'
const PATH = 'content/zh-hant/articles/first-party-release.md'

function planned(target = makeTarget(), publication = makePublication()) {
  const result = planFirstPartyPublication(target, publication, FIXTURE_NOW)
  expect(result.status).toBe('planned')
  if (result.status !== 'planned') throw new Error(`expected plan, got ${result.code}`)
  return result
}

function fetchMock(...responses: Awaited<ReturnType<FirstPartyFetch>>[]): FirstPartyFetch {
  return vi.fn().mockImplementation(async () => responses.shift() ?? response(500, {})) as unknown as FirstPartyFetch
}

function credentialResolver() {
  return vi.fn().mockResolvedValue({ ok: true as const, value: MOCK_CREDENTIAL })
}

function existingArtifactResponse(target: FirstPartyPublishTarget = makeTarget(), publication = makePublication()) {
  const plan = planned(target, publication)
  const bytes = `${plan.artifact.frontmatter}\n${plan.artifact.body}`
  return response(200, { type: 'file', path: PATH, sha: 'abcdef1234567', encoding: 'base64', content: Buffer.from(bytes, 'utf8').toString('base64'), repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })
}

describe('first-party executor boundaries', () => {
  it('dry_run plans but never calls fetch or resolves a credential', async () => {
    const fetchImpl = vi.fn()
    const resolver = credentialResolver()
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'dry_run', fetchImpl, serverCredentialResolver: resolver })
    expect(result.status).toBe('dry_run')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(resolver).not.toHaveBeenCalled()
    if (result.status === 'dry_run') {
      expect(result.preview.bodyIncluded).toBe(false)
      expect(result.preview.includesAuthorization).toBe(false)
      expect(result.preview.includesSecret).toBe(false)
      expect(result.preview.headerNames).not.toContain('authorization')
      expect(result.preview.url).not.toContain('?ref=')
    }
  })

  it('blocked plan input has zero fetch calls', async () => {
    const fetchImpl = vi.fn()
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication({ reviewDecision: 'approved_for_preview' }), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'PUBLICATION_NOT_APPROVED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('executionEnabled=false has zero fetch calls and zero credential resolution', async () => {
    const fetchImpl = vi.fn()
    const resolver = credentialResolver()
    const result = await executeFirstPartyPublication({ target: makeTarget({ executionEnabled: false }), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: resolver })
    expect(result).toMatchObject({ status: 'blocked', code: 'EXECUTION_DISABLED' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(resolver).not.toHaveBeenCalled()
  })

  it.each(['paused', 'revoked'] as const)('non-active target %s has zero fetch calls', async status => {
    const fetchImpl = vi.fn()
    const result = await executeFirstPartyPublication({ target: makeTarget({ status }), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'TARGET_NOT_ACTIVE' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('missing resolver is blocked before fetch', async () => {
    const fetchImpl = vi.fn()
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl })
    expect(result).toMatchObject({ status: 'blocked', code: 'CREDENTIAL_MISSING' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('missing resolved credential is blocked before fetch', async () => {
    const fetchImpl = vi.fn()
    const resolver = vi.fn().mockResolvedValue({ ok: false as const, reason: 'missing' as const })
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: resolver })
    expect(result).toMatchObject({ status: 'blocked', code: 'CREDENTIAL_MISSING' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires an injected nonce for signed execution before credential resolution or fetch', async () => {
    const fetchImpl = vi.fn()
    const resolver = credentialResolver()
    const result = await executeFirstPartyPublication({ target: makeSignedTarget(), publication: makePublication({ language: 'en', slug: 'signed-release' }), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: resolver })
    expect(result).toMatchObject({ status: 'blocked', code: 'NONCE_INVALID' })
    expect(resolver).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('owner mismatch is blocked before fetch', async () => {
    const fetchImpl = vi.fn()
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication({ ownerScopeKey: 'other-owner' }), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'OWNER_SCOPE_MISMATCH' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('unknown context publication keys fail closed', async () => {
    const fetchImpl = vi.fn()
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: { ...makePublication(), rawCredential: 'not accepted' }, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'PUBLICATION_NOT_APPROVED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('GitHub Contents adapter', () => {
  it('creates a new Markdown file with one GET followed by one PUT', async () => {
    const plannedResult = planned()
    const calls: unknown[] = []
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init: unknown) => { calls.push({ url, init }); return calls.length === 1 ? response(404, {}) : gitCreateResponse() }) as unknown as FirstPartyFetch
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'created', publicationId: 'deliverable-001', contentHash: plannedResult.artifact.contentHash })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const get = calls[0] as { url: string }
    const put = calls[1] as { url: string; init: { method: string; body: string; redirect: string; headers: Record<string, string> } }
    expect(get.url).toBe('https://api.github.com/repos/example-owner/example-site/contents/content/zh-hant/articles/first-party-release.md?ref=main')
    expect(put.url).toBe('https://api.github.com/repos/example-owner/example-site/contents/content/zh-hant/articles/first-party-release.md')
    expect(put.init.method).toBe('PUT')
    expect(put.init.redirect).toBe('manual')
    expect(put.init.headers.authorization).toBe(`Bearer ${MOCK_CREDENTIAL}`)
    expect(put.init.headers['x-github-api-version']).toBe('2026-03-10')
    const body = JSON.parse(put.init.body) as Record<string, unknown>
    expect(body.branch).toBe('main')
    expect(body.message).toBe('publish:deliverable-001:' + makePublication().contentHash.slice(0, 12))
    expect(body).not.toHaveProperty('credential')
    expect(body).not.toHaveProperty('token')
  })

  it('updates an existing file with the remote SHA and canonical branch', async () => {
    const calls: unknown[] = []
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init: unknown) => { calls.push({ url, init }); return calls.length === 1 ? gitFileResponse() : gitUpdateResponse() }) as unknown as FirstPartyFetch
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'updated', remoteRevision: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' })
    const put = calls[1] as { init: { body: string } }
    const body = JSON.parse(put.init.body) as Record<string, unknown>
    expect(body.sha).toBe('abcdef1234567')
    expect(body.branch).toBe('main')
  })

  it('recognizes an idempotent replay without issuing PUT', async () => {
    const fetchImpl = fetchMock(existingArtifactResponse())
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'idempotent_replay' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('blocks a publicationId collision when the remote content hash differs', async () => {
    const bytes = '---\npublicationId: "deliverable-001"\ncontentHash: "' + sha256('other') + '"\n---\nold'
    const fetchImpl = fetchMock(response(200, { type: 'file', path: PATH, sha: 'abcdef1234567', encoding: 'base64', content: Buffer.from(bytes, 'utf8').toString('base64'), repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' }))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not trust matching frontmatter hashes when the remote artifact bytes were altered', async () => {
    const plan = planned()
    const altered = `${plan.artifact.frontmatter}\nbody altered after publication`
    const fetchImpl = fetchMock(response(200, { type: 'file', path: PATH, sha: 'abcdef1234567', encoding: 'base64', content: Buffer.from(altered, 'utf8').toString('base64'), repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' }))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reads replay identity only from the leading frontmatter block', async () => {
    const publication = makePublication()
    const bodySpoof = `---\ntitle: "legacy"\n---\npublicationId: ${JSON.stringify(publication.productionDeliverableId)}\ncontentHash: ${JSON.stringify(publication.contentHash)}`
    const fetchImpl = fetchMock(
      response(200, { type: 'file', path: PATH, sha: 'abcdef1234567', encoding: 'base64', content: Buffer.from(bodySpoof, 'utf8').toString('base64'), repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' }),
      gitUpdateResponse(),
    )
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'updated' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('blocks malformed or duplicate remote frontmatter identity', async () => {
    const publication = makePublication()
    const malformed = `---\npublicationId: ${JSON.stringify(publication.productionDeliverableId)}\npublicationId: ${JSON.stringify(publication.productionDeliverableId)}\ncontentHash: ${JSON.stringify(publication.contentHash)}\n---\nbody`
    const fetchImpl = fetchMock(response(200, { type: 'file', path: PATH, sha: 'abcdef1234567', encoding: 'base64', content: Buffer.from(malformed, 'utf8').toString('base64'), repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' }))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects non-canonical base64 in an existing GitHub file response', async () => {
    const fetchImpl = fetchMock(response(200, { type: 'file', path: PATH, sha: 'abcdef1234567', encoding: 'base64', content: 'YWJj===', repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' }))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'RESPONSE_INVALID' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('validates response repository, path, and branch identity', async () => {
    const wrongRepository = fetchMock(response(200, { content: { sha: 'abcdef1234567', content: Buffer.from('old').toString('base64'), encoding: 'base64' }, path: PATH, repository: { owner: 'other-owner', name: 'example-site' }, branch: 'main' }))
    const wrongPath = fetchMock(response(200, { content: { sha: 'abcdef1234567', content: Buffer.from('old').toString('base64'), encoding: 'base64' }, path: 'content/other.md', repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' }))
    const wrongBranch = fetchMock(response(200, { content: { sha: 'abcdef1234567', content: Buffer.from('old').toString('base64'), encoding: 'base64' }, path: PATH, repository: { owner: 'example-owner', name: 'example-site' }, branch: 'release' }))
    for (const fetchImpl of [wrongRepository, wrongPath, wrongBranch]) {
      const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
      expect(result).toMatchObject({ status: 'blocked', code: 'RESPONSE_INVALID' })
    }
  })

  it('rejects permissive or partial repository echoes', async () => {
    for (const repository of ['example-owner', 'example-site', 'main', { owner: 'example-owner' }, { name: 'example-site' }]) {
      const fetchImpl = fetchMock(response(200, { content: { sha: 'abcdef1234567', content: Buffer.from('old').toString('base64'), encoding: 'base64' }, path: PATH, repository, branch: 'main' }))
      const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
      expect(result).toMatchObject({ status: 'blocked', code: 'RESPONSE_INVALID' })
    }
  })

  it('accepts the real GitHub response shape when the canonical content URL binds repository and path', async () => {
    const canonicalUrl = `https://api.github.com/repos/example-owner/example-site/contents/${PATH}`
    const fetchImpl = fetchMock(
      response(404, {}),
      response(201, { content: { path: PATH, url: canonicalUrl, sha: 'abcdef1234567' }, commit: { sha: '1234567890abcdef1234567890abcdef12345678' } }),
    )
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'created' })
  })

  it('rejects a GitHub response that omits every repository binding', async () => {
    const fetchImpl = fetchMock(response(404, {}), response(201, { content: { path: PATH, sha: 'abcdef1234567' }, commit: { sha: '1234567890abcdef1234567890abcdef12345678' } }))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'RESPONSE_INVALID' })
  })

  it('revalidates direct Git adapter command and artifact bindings before resolving credentials or fetching', async () => {
    const targetResult = validateFirstPartyPublishTarget(makeTarget())
    expect(targetResult.status).toBe('valid')
    if (targetResult.status !== 'valid') throw new Error('fixture target is invalid')
    const publication = makePublication()
    const plan = planned(makeTarget(), publication)
    const fetchImpl = vi.fn() as unknown as FirstPartyFetch
    const resolver = credentialResolver()
    const result = await executeGitContentsPublish({ target: targetResult.target, publication, artifact: { ...plan.artifact, body: 'tampered body' }, command: plan.command, now: FIXTURE_NOW, fetchImpl }, { fetchImpl, serverCredentialResolver: resolver })
    expect(result).toMatchObject({ status: 'blocked', code: 'ARTIFACT_FINGERPRINT_INVALID' })
    expect(resolver).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects malformed GitHub JSON without exposing raw response', async () => {
    const fetchImpl = fetchMock(textResponse(200, '{malformed'))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'RESPONSE_INVALID' })
    expect(JSON.stringify(result)).not.toContain('malformed')
  })

  it('rejects a malformed write response without treating 2xx as trusted success', async () => {
    const fetchImpl = fetchMock(response(404, {}), response(201, { content: { path: PATH, sha: 'bad' }, commit: { sha: 'bad' } }))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'RESPONSE_INVALID' })
  })

  it.each([
    [401, 'REMOTE_UNAUTHORIZED', 'permanent_failure'],
    [403, 'REMOTE_UNAUTHORIZED', 'permanent_failure'],
    [409, 'REMOTE_CONFLICT', 'permanent_failure'],
    [422, 'REMOTE_CONFLICT', 'permanent_failure'],
    [429, 'REMOTE_RATE_LIMITED', 'retryable_failure'],
    [500, 'REMOTE_SERVER_ERROR', 'retryable_failure'],
    [503, 'REMOTE_SERVER_ERROR', 'retryable_failure'],
  ] as const)('classifies Git status %s without blind retry', async (status, code, resultStatus) => {
    const fetchImpl = fetchMock(response(status, {}))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: resultStatus, code, httpStatus: status })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('blocks redirects and never follows them', async () => {
    const fetchImpl = fetchMock(response(302, { location: 'https://other.example' }))
    const result = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'blocked', code: 'REDIRECT_BLOCKED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('maps timeout and network exceptions to safe non-sensitive results', async () => {
    const timeoutFetch = vi.fn().mockRejectedValue(new Error('request aborted by timeout fixture-key-material')) as unknown as FirstPartyFetch
    const networkFetch = vi.fn().mockRejectedValue(new Error('fixture-key-material socket failure')) as unknown as FirstPartyFetch
    const timeout = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl: timeoutFetch, serverCredentialResolver: credentialResolver() })
    const network = await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl: networkFetch, serverCredentialResolver: credentialResolver() })
    expect(timeout).toMatchObject({ status: 'retryable_failure', code: 'TIMEOUT' })
    expect(network).toMatchObject({ status: 'retryable_failure', code: 'NETWORK_FAILURE' })
    expect(JSON.stringify(timeout)).not.toContain(MOCK_CREDENTIAL)
    expect(JSON.stringify(network)).not.toContain(MOCK_CREDENTIAL)
  })

  it('uses bounded timeout and manual redirect in every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(404, {})).mockResolvedValueOnce(gitCreateResponse()) as unknown as FirstPartyFetch
    await executeFirstPartyPublication({ target: makeTarget(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    for (const call of (fetchImpl as unknown as { mock: { calls: Array<[string, { timeoutMs: number; redirect: string }]> } }).mock.calls) {
      expect(call[1].timeoutMs).toBeGreaterThan(0)
      expect(call[1].timeoutMs).toBeLessThanOrEqual(120_000)
      expect(call[1].redirect).toBe('manual')
    }
  })
})

describe('signed API adapter', () => {
  it('signs the canonical fields and sends no Authorization header', async () => {
    const target = makeSignedTarget()
    const publication = makePublication({ language: 'en', slug: 'signed-release' })
    const plan = planned(target, publication)
    const fetchImpl = vi.fn().mockResolvedValue(signedResponse(publication.productionDeliverableId, publication.contentHash)) as unknown as FirstPartyFetch
    const resolver = credentialResolver()
    const result = await executeFirstPartyPublication({ target, publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: resolver, nonceProvider: () => 'nonce-001' })
    expect(result).toMatchObject({ status: 'delivered', remoteRevision: 'revision-001', publicationId: 'deliverable-001' })
    expect(resolver).toHaveBeenCalledWith('hmac-key:client-abc')
    const request = (fetchImpl as unknown as { mock: { calls: Array<[string, { headers: Record<string, string>; body: string; redirect: string; method: string }]> } }).mock.calls[0]
    expect(request?.[0]).toBe('https://client.example.com/api/first-party/content-ingest')
    expect(request?.[1].method).toBe('POST')
    expect(request?.[1].redirect).toBe('manual')
    const validated = validateFirstPartyPublishTarget(target)
    expect(validated.status).toBe('valid')
    if (validated.status !== 'valid') throw new Error('fixture target is invalid')
    const signedInput = { target: validated.target, publication, artifact: plan.artifact, command: plan.command, now: FIXTURE_NOW, fetchImpl }
    expect(request?.[1].headers['x-discoverystack-signature']).toBe(buildSignedApiSignature(signedInput, MOCK_CREDENTIAL, FIXTURE_NOW, 'nonce-001'))
    expect(request?.[1].headers).not.toHaveProperty('authorization')
    expect(JSON.stringify(result)).not.toContain(MOCK_CREDENTIAL)
  })

  it('changes signature when body/hash/timestamp/nonce changes', () => {
    const target = makeSignedTarget()
    const base = planned(target, makePublication({ language: 'en', slug: 'signed-release' }))
    const baseInput = { target, publication: makePublication({ language: 'en', slug: 'signed-release' }), artifact: base.artifact, command: base.command, now: FIXTURE_NOW, fetchImpl: vi.fn() as unknown as FirstPartyFetch }
    const first = buildSignedApiSignature(baseInput, MOCK_CREDENTIAL, FIXTURE_NOW, 'nonce-001')
    const otherNonce = buildSignedApiSignature(baseInput, MOCK_CREDENTIAL, FIXTURE_NOW, 'nonce-002')
    const otherTime = buildSignedApiSignature(baseInput, MOCK_CREDENTIAL, '2026-08-25T00:00:01.000Z', 'nonce-001')
    const otherBodyPlan = planned(target, makePublication({ language: 'en', slug: 'signed-release', body: 'different body' }))
    const otherBody = buildSignedApiSignature({ ...baseInput, publication: makePublication({ language: 'en', slug: 'signed-release', body: 'different body' }), artifact: otherBodyPlan.artifact, command: otherBodyPlan.command }, MOCK_CREDENTIAL, FIXTURE_NOW, 'nonce-001')
    expect(new Set([first, otherNonce, otherTime, otherBody]).size).toBe(4)
  })

  it.each([
    ['publicationId', { publicationId: 'other-publication', contentHash: sha256('different'), remoteRevision: 'revision-001' }],
    ['contentHash', { publicationId: 'deliverable-001', contentHash: sha256('different'), remoteRevision: 'revision-001' }],
    ['remoteRevision', { publicationId: 'deliverable-001', contentHash: makePublication({ language: 'en', slug: 'signed-release' }).contentHash, remoteRevision: 'not safe value!' }],
    ['malformed JSON', undefined],
  ] as const)('rejects signed response identity mismatch: %s', async (_label, payload) => {
    const target = makeSignedTarget()
    const publication = makePublication({ language: 'en', slug: 'signed-release' })
    const fetchImpl = fetchMock(payload === undefined ? textResponse(201, '{bad') : response(201, payload))
    const result = await executeFirstPartyPublication({ target, publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver(), nonceProvider: () => 'nonce-001' })
    expect(result).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
  })

  it('requires server-side resolver and injected nonce', async () => {
    const target = makeSignedTarget()
    const publication = makePublication({ language: 'en', slug: 'signed-release' })
    const fetchImpl = vi.fn() as unknown as FirstPartyFetch
    const validated = validateFirstPartyPublishTarget(target)
    expect(validated.status).toBe('valid')
    if (validated.status !== 'valid') throw new Error('fixture target is invalid')
    const plan = planned(target, publication)
    const missingResolver = await executeSignedApiPublish({ target: validated.target, publication, artifact: plan.artifact, command: plan.command, now: FIXTURE_NOW, fetchImpl }, { fetchImpl, serverCredentialResolver: undefined as never, nonceProvider: () => 'nonce-001' })
    expect(missingResolver).toMatchObject({ status: 'blocked', code: 'CREDENTIAL_MISSING' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([302, 401, 403, 409, 422, 429, 500, 503] as const)('handles signed API status %s without treating it as delivered', async status => {
    const target = makeSignedTarget()
    const publication = makePublication({ language: 'en', slug: 'signed-release' })
    const fetchImpl = fetchMock(response(status, {}))
    const result = await executeFirstPartyPublication({ target, publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver(), nonceProvider: () => 'nonce-001' })
    expect(result.status).not.toBe('delivered')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('maps signed API timeout and network errors without leaking the secret', async () => {
    const target = makeSignedTarget()
    const publication = makePublication({ language: 'en', slug: 'signed-release' })
    const timeoutFetch = vi.fn().mockRejectedValue(new Error('abort timeout fixture-key-material')) as unknown as FirstPartyFetch
    const networkFetch = vi.fn().mockRejectedValue(new Error('fixture-key-material network')) as unknown as FirstPartyFetch
    const timeout = await executeFirstPartyPublication({ target, publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl: timeoutFetch, serverCredentialResolver: credentialResolver(), nonceProvider: () => 'nonce-001' })
    const network = await executeFirstPartyPublication({ target, publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl: networkFetch, serverCredentialResolver: credentialResolver(), nonceProvider: () => 'nonce-001' })
    expect(timeout).toMatchObject({ status: 'retryable_failure', code: 'TIMEOUT' })
    expect(network).toMatchObject({ status: 'retryable_failure', code: 'NETWORK_FAILURE' })
    expect(JSON.stringify(timeout)).not.toContain(MOCK_CREDENTIAL)
    expect(JSON.stringify(network)).not.toContain(MOCK_CREDENTIAL)
  })

  it('rejects a malformed nonce before fetch', async () => {
    const target = makeSignedTarget()
    const publication = makePublication({ language: 'en', slug: 'signed-release' })
    const fetchImpl = vi.fn() as unknown as FirstPartyFetch
    const result = await executeFirstPartyPublication({ target, publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver(), nonceProvider: () => 'bad nonce' })
    expect(result).toMatchObject({ status: 'blocked', code: 'NONCE_INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})


describe('signed API timestamp policy', () => {
  it('blocks an injected serverNow outside the fixed five-minute tolerance before fetch', async () => {
    const target = makeSignedTarget()
    const publication = makePublication({ language: 'en', slug: 'signed-release' })
    const fetchImpl = vi.fn() as unknown as FirstPartyFetch
    const result = await executeFirstPartyPublication({ target, publication, now: FIXTURE_NOW, serverNow: '2026-08-25T00:05:01.000Z', mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver(), nonceProvider: () => 'nonce-001' })
    expect(result).toMatchObject({ status: 'blocked', code: 'INVALID_TIMESTAMP' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
