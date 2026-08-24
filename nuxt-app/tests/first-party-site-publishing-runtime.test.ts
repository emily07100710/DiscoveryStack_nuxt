import { describe, expect, it } from 'vitest'
import { buildFirstPartyMarkdownArtifact, computeDeliveryIdempotencyKey, planFirstPartyPublication } from '../server/first-party-publishing'
import { validateDeliveryTarget } from '../server/delivery-automation/target-guard'
import { validateFirstPartyPublishTarget } from '../server/first-party-publishing/target-guard'
import { makePublication, makeSignedTarget, makeTarget, FIXTURE_BODY, FIXTURE_EVIDENCE, FIXTURE_NOW, sha256 } from './fixtures/first-party-publishing/fixtures'
import type { FirstPartyPublishTarget } from '../server/first-party-publishing'

function expectBlocked(result: { status: string; code?: string }, code: string) {
  expect(result.status).toBe('blocked')
  expect(result.code).toBe(code)
}

function expectPlanned(target: FirstPartyPublishTarget = makeTarget(), publication = makePublication()) {
  const result = planFirstPartyPublication(target, publication, FIXTURE_NOW)
  expect(result.status).toBe('planned')
  if (result.status !== 'planned') throw new Error(`expected planned result, got ${result.code}`)
  return result
}

describe('first-party artifact runtime', () => {
  it('builds an Astro zh-hant artifact at the default path', () => {
    const result = buildFirstPartyMarkdownArtifact('content', makePublication())
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.artifact.path).toBe('content/zh-hant/articles/first-party-release.md')
      expect(result.artifact.body).toBe(FIXTURE_BODY)
      expect(result.artifact.contentHash).toBe(sha256(FIXTURE_BODY))
      expect(result.artifact.frontmatter).toContain('publicationId: "deliverable-001"')
      expect(result.artifact.frontmatter).toContain('authoritySourceIds: ["source-001"]')
      expect(result.artifact.frontmatter).toContain('appliedRuleIds: ["rule-001"]')
    }
  })

  it('builds a Nuxt English artifact at the default path', () => {
    const result = buildFirstPartyMarkdownArtifact('content', makePublication({ language: 'en', slug: 'english-release' }))
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.artifact.path).toBe('content/en/articles/english-release.md')
  })

  it.each([
    ['en', 'article', 'content/en/articles/english-article.md'],
    ['zh-hant', 'article', 'content/zh-hant/articles/zh-article.md'],
    ['en', 'faq', 'content/en/faq/english-faq.md'],
    ['zh-hant', 'service_page', 'content/zh-hant/services/zh-service.md'],
  ] as const)('maps %s %s to the formal artifact path', (language, contentType, expectedPath) => {
    const result = buildFirstPartyMarkdownArtifact('content', makePublication({ language, contentType, slug: expectedPath.split('/').at(-1)?.replace(/\.md$/, '') ?? 'release' }))
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.artifact.path).toBe(expectedPath)
  })

  it('blocks unsupported language or content type instead of choosing a default folder', () => {
    expectBlocked(buildFirstPartyMarkdownArtifact('content', makePublication({ language: 'fr' })), 'ARTIFACT_PATH_INVALID')
    expectBlocked(buildFirstPartyMarkdownArtifact('content', makePublication({ contentType: 'landing' })), 'ARTIFACT_PATH_INVALID')
  })

  it('keeps frontmatter key ordering deterministic', () => {
    const publication = makePublication()
    const first = buildFirstPartyMarkdownArtifact('content', publication)
    const second = buildFirstPartyMarkdownArtifact('content', publication)
    expect(first).toEqual(second)
    if (first.status === 'ok') {
      const keys = first.artifact.frontmatter.split('\n').slice(1, -1).map(line => line.split(':')[0])
      expect(keys).toEqual(['title', 'slug', 'language', 'contentType', 'publicationId', 'scheduleEntryId', 'productionPlanId', 'draftId', 'reviewId', 'evidenceSnapshotHash', 'contentHash', 'publishedAt', 'authoritySourceIds', 'appliedRuleIds'])
    }
  })

  it('serializes frontmatter values so delimiter injection remains data', () => {
    const result = buildFirstPartyMarkdownArtifact('content', makePublication({ title: 'Title\n---\ncredential: fake', slug: 'safe-title' }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('INVALID_INPUT')
    const valid = buildFirstPartyMarkdownArtifact('content', makePublication({ title: 'Title: "quoted"', slug: 'safe-title' }))
    expect(valid.status).toBe('ok')
    if (valid.status === 'ok') expect(valid.artifact.frontmatter).toContain('title: "Title: \\"quoted\\""')
  })

  it.each(['../escape', 'a/b', 'a\\b', 'a%2fb', 'a%2e%2e', 'UPPER_CASE', '', '-leading', 'trailing-'])('rejects unsafe slug %s', slug => {
    const result = buildFirstPartyMarkdownArtifact('content', makePublication({ slug }))
    expectBlocked(result, 'INVALID_INPUT')
  })

  it.each(['../content', '/content', 'content/', 'content//nested', 'content/%2e%2e', 'content\\nested', ''])('rejects unsafe content root %s', contentRoot => {
    const result = buildFirstPartyMarkdownArtifact(contentRoot, makePublication())
    expectBlocked(result, 'INVALID_CONTENT_ROOT')
  })

  it('rejects a body whose UTF-8 hash is stale', () => {
    const result = buildFirstPartyMarkdownArtifact('content', makePublication({ contentHash: sha256('different body') }))
    expectBlocked(result, 'CONTENT_HASH_MISMATCH')
  })

  it('rejects an invalid evidence hash before producing an artifact', () => {
    const result = buildFirstPartyMarkdownArtifact('content', makePublication({ evidenceSnapshotHash: 'not-a-hash' }))
    expectBlocked(result, 'INVALID_SHA256')
  })

  it('changes artifact fingerprint when path, body, or identity changes', () => {
    const first = buildFirstPartyMarkdownArtifact('content', makePublication())
    const pathChange = buildFirstPartyMarkdownArtifact('docs', makePublication())
    const bodyChange = buildFirstPartyMarkdownArtifact('content', makePublication({ body: 'different body' }))
    const identityChange = buildFirstPartyMarkdownArtifact('content', makePublication({ productionDeliverableId: 'deliverable-002' }))
    expect(first.status).toBe('ok')
    expect(pathChange.status).toBe('ok')
    expect(bodyChange.status).toBe('ok')
    expect(identityChange.status).toBe('ok')
    if (first.status === 'ok' && pathChange.status === 'ok' && bodyChange.status === 'ok' && identityChange.status === 'ok') {
      expect(first.artifact.artifactFingerprint).not.toBe(pathChange.artifact.artifactFingerprint)
      expect(first.artifact.artifactFingerprint).not.toBe(bodyChange.artifact.artifactFingerprint)
      expect(first.artifact.artifactFingerprint).not.toBe(identityChange.artifact.artifactFingerprint)
    }
  })
})

describe('first-party target guard', () => {
  it('accepts the exact GitHub Contents target', () => {
    const result = validateFirstPartyPublishTarget(makeTarget())
    expect(result.status).toBe('valid')
  })

  it('accepts a public HTTPS signed API target with fixed endpoint', () => {
    const result = validateFirstPartyPublishTarget(makeSignedTarget())
    expect(result.status).toBe('valid')
  })

  it.each(['http://api.github.com', 'https://api.github.com:8443', 'https://api.github.com/path', 'https://api.github.com?x=1', 'https://api.github.com#fragment', 'https://user:pass@api.github.com', 'https://localhost', 'https://service.local', 'https://service.internal', 'https://service.onion', 'https://10.0.0.1', 'https://127.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://[fc00::1]', 'https://[fe80::1]'])('rejects unsafe target origin %s', targetOrigin => {
    const result = validateFirstPartyPublishTarget(makeTarget({ targetOrigin }))
    expectBlocked(result, 'INVALID_TARGET_ORIGIN')
  })

  it('requires first_party_git to use the exact GitHub origin', () => {
    const result = validateFirstPartyPublishTarget(makeTarget({ targetOrigin: 'https://github.com' }))
    expectBlocked(result, 'INVALID_TARGET_ORIGIN')
  })

  it('rejects a signed API endpoint other than the fixed path', () => {
    const result = validateFirstPartyPublishTarget(makeSignedTarget({ endpointPath: '/api/other' }))
    expectBlocked(result, 'INVALID_ENDPOINT_PATH')
  })

  it('rejects repository fields on signed API targets', () => {
    const result = validateFirstPartyPublishTarget(makeSignedTarget({ repositoryOwner: 'owner' }))
    expectBlocked(result, 'INVALID_ENDPOINT_PATH')
  })

  it.each(['', '../main', '/main', 'main/', 'main..bad', 'main\\bad', 'main@{bad'])('rejects unsafe branches %s', defaultBranch => {
    const result = validateFirstPartyPublishTarget(makeTarget({ defaultBranch }))
    expectBlocked(result, 'INVALID_BRANCH')
  })

  it('rejects malformed repository owner/name independently', () => {
    expectBlocked(validateFirstPartyPublishTarget(makeTarget({ repositoryOwner: '../owner' })), 'INVALID_REPOSITORY')
    expectBlocked(validateFirstPartyPublishTarget(makeTarget({ repositoryName: 'repo/name' })), 'INVALID_REPOSITORY')
  })

  it.each(['plain-token', 'secret-value', 'Authorization: value', 'https://example.com/key', 'has space', ''])('rejects credential references that are not opaque server references: %s', credentialReference => {
    const result = validateFirstPartyPublishTarget(makeTarget({ credentialReference }))
    expectBlocked(result, 'INVALID_CREDENTIAL_REFERENCE')
  })

  it.each(['unknown', 'astro ', 'NUXT'])('rejects unknown framework %s', framework => {
    const result = validateFirstPartyPublishTarget(makeTarget({ framework: framework as FirstPartyPublishTarget['framework'] }))
    expectBlocked(result, 'UNSUPPORTED_FRAMEWORK')
  })

  it('rejects an unknown transport', () => {
    expectBlocked(validateFirstPartyPublishTarget(makeTarget({ transport: 'generic_http' as FirstPartyPublishTarget['transport'] })), 'UNSUPPORTED_TRANSPORT')
  })

  it.each(['paused', 'revoked'])('rejects non-active target status %s', status => {
    expectBlocked(validateFirstPartyPublishTarget(makeTarget({ status: status as FirstPartyPublishTarget['status'] })), 'TARGET_NOT_ACTIVE')
  })

  it('rejects executionEnabled with the wrong type', () => {
    expectBlocked(validateFirstPartyPublishTarget({ ...makeTarget(), executionEnabled: 'true' }), 'INVALID_INPUT')
  })

  it('rejects an unknown target key instead of ignoring it', () => {
    expectBlocked(validateFirstPartyPublishTarget({ ...makeTarget(), ignored: true }), 'INVALID_INPUT')
  })

  it('does not accept a content type token as an allowed language', () => {
    expectBlocked(validateFirstPartyPublishTarget(makeTarget({ allowedLanguages: ['article'] })), 'INVALID_INPUT')
  })

  it('rejects null, arrays, and getter failures', () => {
    expectBlocked(validateFirstPartyPublishTarget(null), 'INVALID_INPUT')
    expectBlocked(validateFirstPartyPublishTarget([]), 'INVALID_INPUT')
    const throwing = Object.defineProperty({}, 'targetId', { get() { throw new Error('fixture getter') } })
    expectBlocked(validateFirstPartyPublishTarget(throwing), 'INVALID_INPUT')
  })
})

describe('first-party plan and approval gates', () => {
  it('plans a metadata-only command for an approved optimized publication', () => {
    const result = expectPlanned()
    expect(result.command.transport).toBe('first_party_git')
    expect(result.command.framework).toBe('astro')
    expect(result.command.contentPath).toBe('content/zh-hant/articles/first-party-release.md')
    expect(result.command.limitations).toEqual(['metadata_only', 'not_delivered', 'executor_must_revalidate'])
    expect(result.command.attemptNumber).toBe(1)
    expect(result.command.provenance.credentialReference).toBe('github-app-installation:123')
    expect(result.command).not.toHaveProperty('body')
    expect(result.command).not.toHaveProperty('secret')
    expect(result.command).not.toHaveProperty('authorization')
  })

  it.each([
    ['base', { draftStage: 'base' }],
    ['preview-only', { reviewDecision: 'approved_for_preview' }],
    ['risk-blocked', { riskGateStatus: 'blocked' }],
  ])('rejects %s publication approval', (_label, override) => {
    const result = planFirstPartyPublication(makeTarget(), makePublication(override), FIXTURE_NOW)
    expectBlocked(result, 'PUBLICATION_NOT_APPROVED')
  })

  it('rejects owner scope mismatch', () => {
    const result = planFirstPartyPublication(makeTarget(), makePublication({ ownerScopeKey: 'other-owner' }), FIXTURE_NOW)
    expectBlocked(result, 'OWNER_SCOPE_MISMATCH')
  })

  it('rejects a future scheduledAt', () => {
    const result = planFirstPartyPublication(makeTarget(), makePublication({ scheduledAt: '2026-08-26T00:00:00.000Z' }), FIXTURE_NOW)
    expectBlocked(result, 'SCHEDULED_IN_FUTURE')
  })

  it('rejects disallowed content type and language', () => {
    expectBlocked(planFirstPartyPublication(makeTarget(), makePublication({ contentType: 'video' }), FIXTURE_NOW), 'UNSUPPORTED_CONTENT_TYPE')
    expectBlocked(planFirstPartyPublication(makeTarget(), makePublication({ language: 'fr' }), FIXTURE_NOW), 'UNSUPPORTED_LANGUAGE')
  })

  it('rejects a payload over target maximum', () => {
    const result = planFirstPartyPublication(makeTarget({ maximumPayloadBytes: 10 }), makePublication(), FIXTURE_NOW)
    expectBlocked(result, 'CONTENT_TOO_LARGE')
  })

  it('rejects an unknown publication key', () => {
    expectBlocked(planFirstPartyPublication(makeTarget(), { ...makePublication(), credential: 'not accepted' }, FIXTURE_NOW), 'PUBLICATION_NOT_APPROVED')
  })

  it('rejects malformed injected now and invalid publication timestamp', () => {
    expectBlocked(planFirstPartyPublication(makeTarget(), makePublication(), '2026-02-30T00:00:00.000Z'), 'INVALID_TIMESTAMP')
    expectBlocked(planFirstPartyPublication(makeTarget(), makePublication({ scheduledAt: '2026-02-30T00:00:00.000Z' }), FIXTURE_NOW), 'INVALID_TIMESTAMP')
  })

  it('uses canonical idempotency inputs and excludes arbitrary body fields', () => {
    const first = expectPlanned()
    const second = expectPlanned()
    expect(first.command.idempotencyKey).toBe(second.command.idempotencyKey)
    const changedBody = expectPlanned(makeTarget(), makePublication({ body: 'new body' }))
    expect(changedBody.command.idempotencyKey).not.toBe(first.command.idempotencyKey)
  })

  it('computes a deterministic SHA-256 idempotency key for the full publication identity', () => {
    const first = computeDeliveryIdempotencyKey({ targetId: 'target-001', ownerScopeKey: 'owner-001', framework: 'astro', transport: 'first_party_git', targetOrigin: 'https://api.github.com', contentRoot: 'content', repositoryOwner: 'example-owner', repositoryName: 'example-site', endpointPath: null, publicationId: 'publication-001', productionDeliverableId: 'deliverable-001', contentHash: sha256(FIXTURE_BODY), evidenceSnapshotHash: FIXTURE_EVIDENCE, path: 'content/en/articles/article.md', branch: 'main', scheduleEntryId: 'schedule-001', productionPlanId: 'plan-001', jobId: 'job-001', draftId: 'draft-001', draftVersion: 1, reviewId: 'review-001', scheduleKey: 'schedule-key-001', artifactFingerprint: sha256('artifact') })
    const second = computeDeliveryIdempotencyKey({ targetId: 'target-001', ownerScopeKey: 'owner-001', framework: 'astro', transport: 'first_party_git', targetOrigin: 'https://api.github.com', contentRoot: 'content', repositoryOwner: 'example-owner', repositoryName: 'example-site', endpointPath: null, publicationId: 'publication-001', productionDeliverableId: 'deliverable-001', contentHash: sha256(FIXTURE_BODY), evidenceSnapshotHash: FIXTURE_EVIDENCE, path: 'content/en/articles/article.md', branch: 'main', scheduleEntryId: 'schedule-001', productionPlanId: 'plan-001', jobId: 'job-001', draftId: 'draft-001', draftVersion: 1, reviewId: 'review-001', scheduleKey: 'schedule-key-001', artifactFingerprint: sha256('artifact') })
    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
  })

  it('accepts a valid leap-day and equivalent offset timestamp through eligibility', () => {
    const publication = makePublication({ scheduledAt: '2028-02-29T00:00:00.000+08:00' })
    const result = planFirstPartyPublication(makeTarget(), publication, '2028-02-28T16:00:00.000Z')
    expect(result.status).toBe('planned')
  })
})

describe('legacy delivery compatibility contract', () => {
  it('retains legacy adapters while accepting first-party adapter values', () => {
    const legacy = validateDeliveryTarget({ targetId: 'target-legacy', ownerScopeKey: 'owner-legacy', adapter: 'wordpress_rest', targetOrigin: 'https://legacy.example.com', endpointPath: '/posts', status: 'active', serverCredentialConfigured: true, allowedContentTypes: ['article'], allowedLanguages: ['en'], maximumPayloadBytes: 1000, policyVersion: 'delivery-policy-v1' })
    const firstParty = validateDeliveryTarget({ targetId: 'target-first', ownerScopeKey: 'owner-first', adapter: 'first_party_git', targetOrigin: 'https://api.github.com', endpointPath: '/repos/example/site/contents/article.md', status: 'active', serverCredentialConfigured: true, allowedContentTypes: ['article'], allowedLanguages: ['en'], maximumPayloadBytes: 1000, policyVersion: 'delivery-policy-v1' })
    expect(legacy.status).toBe('valid')
    expect(firstParty.status).toBe('valid')
  })
})
