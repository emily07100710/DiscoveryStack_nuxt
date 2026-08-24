import { createHash } from 'node:crypto'
import type { ApprovedFirstPartyPublication, FirstPartyFetchResponse, FirstPartyPublishTarget } from '../../../server/first-party-publishing'

export const FIXTURE_NOW = '2026-08-25T00:00:00.000Z' as const
export const FIXTURE_BODY = '這是一段可重現的第一方網站內容。\n\nIt is deterministic and source-bound.'
export const FIXTURE_EVIDENCE = createHash('sha256').update('fixture-evidence', 'utf8').digest('hex')

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function makeTarget(overrides: Partial<FirstPartyPublishTarget> = {}): FirstPartyPublishTarget {
  return {
    targetId: 'target-astro-001',
    ownerScopeKey: 'owner-scope-001',
    framework: 'astro',
    transport: 'first_party_git',
    targetOrigin: 'https://api.github.com',
    contentRoot: 'content',
    defaultBranch: 'main',
    repositoryOwner: 'example-owner',
    repositoryName: 'example-site',
    endpointPath: null,
    credentialReference: 'github-app-installation:123',
    status: 'active',
    allowedContentTypes: ['article'],
    allowedLanguages: ['en', 'zh-hant'],
    maximumPayloadBytes: 100_000,
    executionEnabled: true,
    ...overrides,
  }
}

export function makePublication(overrides: Partial<ApprovedFirstPartyPublication> = {}): ApprovedFirstPartyPublication {
  const body = overrides.body ?? FIXTURE_BODY
  return {
    ownerScopeKey: 'owner-scope-001',
    scheduleEntryId: 'schedule-001',
    productionPlanId: 'plan-001',
    productionDeliverableId: 'deliverable-001',
    jobId: 'job-001',
    draftId: 'draft-001',
    draftVersion: 1,
    draftStage: 'optimized',
    reviewId: 'review-001',
    reviewDecision: 'approved_for_delivery',
    riskGateStatus: 'passed',
    evidenceSnapshotHash: FIXTURE_EVIDENCE,
    contentHash: sha256(body),
    title: '第一方網站發布測試',
    body,
    slug: 'first-party-release',
    contentType: 'article',
    language: 'zh-hant',
    scheduledAt: FIXTURE_NOW,
    scheduleKey: 'schedule-key-001',
    authoritySourceIds: ['source-001'],
    ruleIds: ['rule-001'],
    ...overrides,
    ...(overrides.body === undefined && overrides.contentHash !== undefined ? {} : overrides.body === undefined ? {} : { contentHash: overrides.contentHash ?? sha256(body) }),
  }
}

export function makeSignedTarget(overrides: Partial<FirstPartyPublishTarget> = {}): FirstPartyPublishTarget {
  return makeTarget({
    targetId: 'target-nuxt-001',
    framework: 'nuxt',
    transport: 'first_party_signed_api',
    targetOrigin: 'https://client.example.com',
    repositoryOwner: null,
    repositoryName: null,
    endpointPath: '/api/first-party/content-ingest',
    credentialReference: 'hmac-key:client-abc',
    ...overrides,
  })
}

export function response(status: number, payload: unknown): FirstPartyFetchResponse {
  return {
    status,
    headers: {},
    text: async () => JSON.stringify(payload),
  }
}

export function textResponse(status: number, text: string): FirstPartyFetchResponse {
  return { status, headers: {}, text: async () => text }
}

export function gitFileResponse(path = 'content/zh-hant/articles/first-party-release.md', sha = 'abcdef1234567'): FirstPartyFetchResponse {
  return response(200, { type: 'file', path, sha, encoding: 'base64', content: Buffer.from('old content', 'utf8').toString('base64'), repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })
}

export function gitCreateResponse(path = 'content/zh-hant/articles/first-party-release.md'): FirstPartyFetchResponse {
  return response(201, { content: { path, sha: 'abcdef1234567' }, commit: { sha: '1234567890abcdef1234567890abcdef12345678' }, repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })
}

export function gitUpdateResponse(path = 'content/zh-hant/articles/first-party-release.md'): FirstPartyFetchResponse {
  return response(200, { content: { path, sha: 'fedcba7654321' }, commit: { sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' }, repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })
}

export function signedResponse(publicationId = 'deliverable-001', contentHash = sha256(FIXTURE_BODY)): FirstPartyFetchResponse {
  return response(201, { publicationId, contentHash, remoteRevision: 'revision-001' })
}
