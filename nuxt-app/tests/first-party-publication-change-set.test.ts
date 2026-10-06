import { describe, expect, it, vi } from 'vitest'
import { executeFirstPartyPublication, planFirstPartyPublication } from '../server/first-party-publishing'
import { verifyRepositoryChangeSet, repositoryChangeSetTargetFingerprint } from '../server/first-party-publishing/change-set'
import { makePublication, makeTarget, response, FIXTURE_NOW, sha256 } from './fixtures/first-party-publishing/fixtures'
import type { FirstPartyFetch, FirstPartyPublishTarget } from '../server/first-party-publishing'

const PATH = 'content/zh-hant/articles/first-party-release.md'
const REMOTE_BLOB_SHA = 'abcdef1234567'
const REMOTE_COMMIT_SHA = '1234567890abcdef1234567890abcdef12345678'
const MOCK_SECRET = 'change-set-secret-fixture'

function artifactFor(target: FirstPartyPublishTarget, publication: ReturnType<typeof makePublication>): string {
  const plan = planFirstPartyPublication(target, publication, FIXTURE_NOW)
  if (plan.status !== 'planned') throw new Error(`fixture publication did not plan: ${plan.code}`)
  return `${plan.artifact.frontmatter}\n${plan.artifact.body}`
}

function remoteFile(markdown: string, overrides: Record<string, unknown> = {}) {
  return response(200, {
    type: 'file',
    path: PATH,
    sha: REMOTE_BLOB_SHA,
    encoding: 'base64',
    content: Buffer.from(markdown, 'utf8').toString('base64'),
    repository: { owner: 'example-owner', name: 'example-site' },
    branch: 'main',
    ...overrides,
  })
}

function credentialResolver() {
  return vi.fn().mockResolvedValue({ ok: true as const, value: MOCK_SECRET })
}

function updateJourney(target: FirstPartyPublishTarget, current = makePublication(), beforeMarkdown = artifactFor(target, makePublication({
  productionDeliverableId: 'deliverable-previous',
  title: '前一版標題',
  body: '保留段落\n\n移除段落\n\n舊內容段落\n\n仍保留段落',
})), options: { getResponse?: ReturnType<typeof response>; putResponse?: ReturnType<typeof response> } = {}) {
  const calls: Array<{ url: string; init: unknown }> = []
  const fetchImpl = vi.fn(async (url: string, init: unknown) => {
    calls.push({ url, init })
    return calls.length === 1 ? options.getResponse ?? remoteFile(beforeMarkdown, { commit: { sha: REMOTE_COMMIT_SHA } }) : options.putResponse ?? response(200, {
      content: { path: PATH, sha: 'fedcba7654321' },
      commit: { sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      repository: { owner: 'example-owner', name: 'example-site' },
      branch: 'main',
    })
  }) as unknown as FirstPartyFetch
  return {
    calls,
    fetchImpl,
    run: () => executeFirstPartyPublication({
      target,
      publication: current,
      now: FIXTURE_NOW,
      serverNow: FIXTURE_NOW,
      mode: 'execute',
      fetchImpl,
      serverCredentialResolver: credentialResolver(),
    }),
  }
}

describe('first-party Git repository change-set', () => {
  it('returns an exact hash-only paragraph and title diff after a trusted GET→PUT update', async () => {
    const target = makeTarget()
    const current = makePublication({
      productionDeliverableId: 'deliverable-current',
      title: '新版標題',
      body: '保留段落\n\n新內容段落\n\n仍保留段落\n\n新增段落',
    })
    const previous = makePublication({
      productionDeliverableId: 'deliverable-previous',
      title: '前一版標題',
      body: '保留段落\n\n移除段落\n\n舊內容段落\n\n仍保留段落',
    })
    const journey = updateJourney(target, current, artifactFor(target, previous))
    const result = await journey.run()

    expect(result).toMatchObject({ status: 'delivered', remoteState: 'updated' })
    expect(journey.calls).toHaveLength(2)
    const request = journey.calls[1]?.init as { body: string }
    const put = JSON.parse(request.body) as Record<string, unknown>
    expect(put.sha).toBe(REMOTE_BLOB_SHA)
    if (result.status !== 'delivered' || !result.changeSet) throw new Error(`trusted update did not return its repository change-set: ${JSON.stringify(result)}`)
    const changeSet = result.changeSet
    expect(verifyRepositoryChangeSet(changeSet)).toBe(true)
    expect(changeSet).toMatchObject({
      comparisonKind: 'repository_revision_diff',
      liveBeforeState: 'unknown',
      causalEligibility: false,
      readAt: FIXTURE_NOW,
      before: { blobSha: REMOTE_BLOB_SHA, remoteRevision: REMOTE_COMMIT_SHA, bodyHash: sha256(previous.body), contentHash: sha256(previous.body) },
      after: { bodyHash: sha256(current.body), contentHash: sha256(current.body) },
    })
    expect(changeSet.titleChange.kind).toBe('replaced')
    expect(new Set(changeSet.paragraphChanges.map(item => item.kind))).toEqual(new Set(['unmodified', 'removed', 'replaced', 'added']))
    expect(changeSet.paragraphChanges.length + 1).toBeLessThanOrEqual(512)
    expect(changeSet.targetIdentityFingerprint).toBe(repositoryChangeSetTargetFingerprint(target, PATH))
    const serialized = JSON.stringify(changeSet)
    for (const raw of ['保留段落', '移除段落', '舊內容段落', '新內容段落', 'example-owner', 'example-site', 'owner-scope-001', MOCK_SECRET]) expect(serialized).not.toContain(raw)
    expect(changeSet.before).not.toHaveProperty('publicationId')
    expect(changeSet.after).not.toHaveProperty('publicationId')
    expect(changeSet.before).not.toHaveProperty('sourcePath')
    expect(changeSet.after).not.toHaveProperty('sourcePath')
  })

  it('does not attach a change-set when a before document is noncanonical', async () => {
    const target = makeTarget()
    const previous = makePublication({ productionDeliverableId: 'deliverable-previous', body: 'old text' })
    const canonical = artifactFor(target, previous)
    const noncanonical = canonical.replace(/^---\ntitle:[^\n]+\nslug:/, '---\nslug:')
    const journey = updateJourney(target, makePublication({ productionDeliverableId: 'deliverable-current' }), noncanonical)
    const result = await journey.run()
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'updated' })
    expect(result).not.toHaveProperty('changeSet')
    expect(journey.calls).toHaveLength(2)
  })

  it('leaves a delivered update intact when before content exceeds the bounded diff input', async () => {
    const target = makeTarget({ maximumPayloadBytes: 5_000_000 })
    const oversizedBefore = artifactFor(target, makePublication({
      productionDeliverableId: 'deliverable-previous',
      body: `large-${'x'.repeat(1_048_580)}`,
    }))
    const journey = updateJourney(target, makePublication({ productionDeliverableId: 'deliverable-current' }), oversizedBefore)
    const result = await journey.run()
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'updated' })
    expect(result).not.toHaveProperty('changeSet')
    expect(journey.calls).toHaveLength(2)
  })

  it('omits hash-only lineage when the existing PII scanner detects contact data', async () => {
    const target = makeTarget()
    const previous = makePublication({ productionDeliverableId: 'deliverable-previous', body: 'Contact person@example.org for details.' })
    const journey = updateJourney(target, makePublication({ productionDeliverableId: 'deliverable-current' }), artifactFor(target, previous))
    const result = await journey.run()
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'updated' })
    expect(result).not.toHaveProperty('changeSet')
    expect(journey.calls).toHaveLength(2)
  })

  it('does not invent a server read time when a direct execution omits the injected timestamp', async () => {
    const target = makeTarget()
    const previous = makePublication({ productionDeliverableId: 'deliverable-previous', body: 'old body' })
    const calls: unknown[] = []
    const fetchImpl = vi.fn(async (_url: string, _init: unknown) => calls.length++ === 0
      ? remoteFile(artifactFor(target, previous))
      : response(200, { content: { path: PATH, sha: 'fedcba7654321' }, commit: { sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' }, repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })) as unknown as FirstPartyFetch
    const result = await executeFirstPartyPublication({ target, publication: makePublication({ productionDeliverableId: 'deliverable-current' }), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: credentialResolver() })
    expect(result).toMatchObject({ status: 'delivered', remoteState: 'updated' })
    expect(result).not.toHaveProperty('changeSet')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not infer historical before state for idempotent replay or repository 404', async () => {
    const target = makeTarget()
    const current = makePublication()
    const currentMarkdown = artifactFor(target, current)
    const replay = updateJourney(target, current, currentMarkdown)
    const replayResult = await replay.run()
    expect(replayResult).toMatchObject({ status: 'delivered', remoteState: 'idempotent_replay' })
    expect(replayResult).not.toHaveProperty('changeSet')
    expect(replay.calls).toHaveLength(1)

    let createCount = 0
    const createFetch = vi.fn(async () => createCount++ === 0
      ? response(404, {})
      : response(201, { content: { path: PATH, sha: 'abcdef1234567' }, commit: { sha: REMOTE_COMMIT_SHA }, repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })) as unknown as FirstPartyFetch
    const created = await executeFirstPartyPublication({ target, publication: current, now: FIXTURE_NOW, serverNow: FIXTURE_NOW, mode: 'execute', fetchImpl: createFetch, serverCredentialResolver: credentialResolver() })
    expect(created).toMatchObject({ status: 'delivered', remoteState: 'created' })
    expect(created).not.toHaveProperty('changeSet')
    expect(createFetch).toHaveBeenCalledTimes(2)
  })

  it('preserves safe failure for response identity mismatch and GitHub SHA conflict', async () => {
    const target = makeTarget()
    const identityMismatch = updateJourney(target, makePublication(), artifactFor(target, makePublication({ productionDeliverableId: 'deliverable-previous', body: 'old' })), {
      getResponse: remoteFile(artifactFor(target, makePublication({ productionDeliverableId: 'deliverable-previous', body: 'old' })), { repository: { owner: 'other-owner', name: 'example-site' } }),
    })
    const mismatchResult = await identityMismatch.run()
    expect(mismatchResult).toMatchObject({ status: 'blocked', code: 'RESPONSE_INVALID' })
    expect(identityMismatch.calls).toHaveLength(1)

    const conflict = updateJourney(target, makePublication(), artifactFor(target, makePublication({ productionDeliverableId: 'deliverable-previous', body: 'old' })), { putResponse: response(409, {}) })
    const conflictResult = await conflict.run()
    expect(conflictResult).toMatchObject({ status: 'permanent_failure', code: 'REMOTE_CONFLICT' })
    expect(conflictResult).not.toHaveProperty('changeSet')
    expect(conflict.calls).toHaveLength(2)
  })

  it('verifies change-set hashes and rejects unknown fields, forged operations, and invalid fingerprints', async () => {
    const target = makeTarget()
    const previous = makePublication({ productionDeliverableId: 'deliverable-previous', title: 'old title', body: 'old body' })
    const current = makePublication({ productionDeliverableId: 'deliverable-current', title: 'new title', body: 'new body' })
    const journey = updateJourney(target, current, artifactFor(target, previous))
    const result = await journey.run()
    if (result.status !== 'delivered' || !result.changeSet) throw new Error(`trusted update did not return its repository change-set: ${JSON.stringify(result)}`)
    expect(verifyRepositoryChangeSet(result.changeSet)).toBe(true)
    expect(verifyRepositoryChangeSet({ ...result.changeSet, rawText: 'not allowed' })).toBe(false)
    expect(verifyRepositoryChangeSet({ ...result.changeSet, paragraphChanges: [] })).toBe(false)
    expect(verifyRepositoryChangeSet({ ...result.changeSet, changesetFingerprint: '0'.repeat(64) })).toBe(false)
  })
})
