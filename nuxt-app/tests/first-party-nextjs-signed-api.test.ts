import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { executeFirstPartyPublication, planFirstPartyPublication } from '../server/first-party-publishing'
import { buildSignedApiV2Body, buildSignedApiV2Signature, SIGNED_API_V2_VERSION } from '../server/first-party-publishing/signed-api-v2'
import { validateFirstPartyPublishTarget } from '../server/first-party-publishing/target-guard'
import { parseClientInput, parsePublicationTargetInput } from '../server/content-operations/normalization'
import { makeSignedTarget, makePublication, FIXTURE_NOW, response } from './fixtures/first-party-publishing/fixtures'

const target = () => makeSignedTarget({ framework: 'nextjs', targetOrigin: 'https://doalignment.com', allowedLanguages: ['zh-hant'] })
const secret = 'fixture-only-do-receiver-secret-0000000000000000'
const nonce = 'fixture-nonce-12345678'

describe('Next.js journal signed API v2', () => {
  it('signs complete bytes, destination, method, path, timestamp and nonce', async () => {
    const publication = makePublication()
    const fetchImpl = vi.fn(async (_url: string, request: {body?: string; headers?: Record<string,string>}) => {
      const raw = request.body!
      const body = JSON.parse(raw)
      const digest = createHash('sha256').update(raw).digest('hex')
      const expected = createHmac('sha256', secret).update(['first-party-signed-api-v2','POST','/api/first-party/content-ingest','https://doalignment.com',digest,FIXTURE_NOW,nonce].join('\n')).digest('hex')
      expect(request.headers?.['x-discoverystack-signature']).toBe(expected)
      expect(request.headers?.['x-discoverystack-signature-version']).toBe('first-party-signed-api-v2')
      expect(body).toMatchObject({ signatureVersion: 'first-party-signed-api-v2', framework: 'nextjs', identity: { jobId: 'job-001', draftVersion: 1 }, publication: { title: publication.title, body: publication.body } })
      expect(buildSignedApiV2Signature(raw.replace(publication.title, 'changed title'), 'https://doalignment.com', secret, FIXTURE_NOW, nonce)).not.toBe(expected)
      expect(buildSignedApiV2Signature(raw, 'https://other.client.taipei', secret, FIXTURE_NOW, nonce)).not.toBe(expected)
      return response(200, { publicationId: publication.productionDeliverableId, contentHash: publication.contentHash, remoteRevision: 'revision-fixture-001' })
    })
    const result = await executeFirstPartyPublication({target: target(), publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: async()=>({ok:true,value:secret}), nonceProvider:()=>nonce})
    expect(result.status).toBe('delivered')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('cannot use Git or unsupported article categories for the journal framework', () => {
    expect(validateFirstPartyPublishTarget(target()).status).toBe('valid')
    expect(validateFirstPartyPublishTarget({...target(), transport:'first_party_git'})).toMatchObject({status:'blocked',code:'UNSUPPORTED_TRANSPORT'})
    expect(validateFirstPartyPublishTarget({...target(),allowedContentTypes:['faq']})).toMatchObject({status:'blocked',code:'UNSUPPORTED_CONTENT_TYPE'})
  })
  it('bounds the complete wire body before any HTTP request', async () => {
    const publication = makePublication()
    const plan = planFirstPartyPublication(target(),publication,FIXTURE_NOW)
    if(plan.status !== 'planned') throw new Error('fixture plan failed')
    const fetchImpl = vi.fn()
    const result = await executeFirstPartyPublication({target:{...target(),maximumPayloadBytes:plan.artifact.bytes + 1},publication,now:FIXTURE_NOW,mode:'execute',fetchImpl,serverCredentialResolver:async()=>({ok:true,value:secret}),nonceProvider:()=>nonce})
    expect(result).toMatchObject({status:'blocked',code:'CONTENT_TOO_LARGE'})
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// Exact synthetic receiver vector; copied from its fixed v2 fixture without changing any bytes.
// Keep this test self-contained: CI must not depend on a private /tmp checkout.
const GOLDEN = {
  "syntheticOnly": true,
  "config": {
    "enabled": true,
    "targetId": "do-target-fixture",
    "targetOrigin": "https://doalignment.test",
    "contentRoot": "journal",
    "keyReference": "fixture-key-reference",
    "signingSecret": "fixture-only-signing-secret-00000000000000000000"
  },
  "payload": {
    "commandVersion": "first-party-publish-command-v1",
    "signatureVersion": "first-party-signed-api-v2",
    "targetId": "do-target-fixture",
    "publicationId": "publication-7",
    "idempotencyKey": "6b894c0349bf039814c960080e61728f5121efb82abfe6e7a3c4c6e0de2cbdd1",
    "contentHash": "9f0f78c0bca4f290fd840589af6caf67d96a281c96b1aae750928b3109786235",
    "evidenceSnapshotHash": "7f227db1653b6b723b07c8f2f6eb488f1f09e2f083ca7a3f5e02bbb274f5ff2e",
    "artifactFingerprint": "ebb6a30aa999af3ca8a225322e2ea0ca5c59ca1bdbdfcea8a3ae34c7e026b8aa",
    "path": "journal/zh-hant/articles/weekly-practice.md",
    "framework": "nextjs",
    "content": "---\ntitle: \"每週練習測試\"\nslug: \"weekly-practice\"\nlanguage: \"zh-hant\"\ncontentType: \"article\"\npublicationId: \"publication-7\"\nscheduleEntryId: \"entry-7\"\nproductionPlanId: \"plan-3\"\ndraftId: \"draft-5\"\nreviewId: \"review-6\"\nevidenceSnapshotHash: \"7f227db1653b6b723b07c8f2f6eb488f1f09e2f083ca7a3f5e02bbb274f5ff2e\"\ncontentHash: \"9f0f78c0bca4f290fd840589af6caf67d96a281c96b1aae750928b3109786235\"\npublishedAt: \"2026-10-03T00:00:00.000Z\"\nauthoritySourceIds: [\"source-fixture\"]\nappliedRuleIds: [\"rule-fixture\"]\n---\n這是一篇合成測試文章。\n\n## 練習記錄\n\n保持 **穩定**，記錄自己的感受。",
    "timestamp": "2026-10-04T00:00:00.000Z",
    "nonce": "fixture_nonce_00000001",
    "identity": {
      "publicationId": "publication-7",
      "ownerScopeKey": "owner-1",
      "scheduleEntryId": "entry-7",
      "productionPlanId": "plan-3",
      "productionDeliverableId": "publication-7",
      "jobId": "job-4",
      "draftId": "draft-5",
      "draftVersion": 2,
      "reviewId": "review-6",
      "scheduleKey": "schedule-7"
    },
    "publication": {
      "title": "每週練習測試",
      "body": "這是一篇合成測試文章。\n\n## 練習記錄\n\n保持 **穩定**，記錄自己的感受。",
      "slug": "weekly-practice",
      "contentType": "article",
      "language": "zh-hant",
      "scheduledAt": "2026-10-03T00:00:00.000Z",
      "authoritySourceIds": [
        "source-fixture"
      ],
      "ruleIds": [
        "rule-fixture"
      ],
      "draftStage": "optimized",
      "reviewDecision": "approved_for_delivery",
      "riskGateStatus": "passed"
    }
  },
  "rawBody": "{\"commandVersion\":\"first-party-publish-command-v1\",\"signatureVersion\":\"first-party-signed-api-v2\",\"targetId\":\"do-target-fixture\",\"publicationId\":\"publication-7\",\"idempotencyKey\":\"6b894c0349bf039814c960080e61728f5121efb82abfe6e7a3c4c6e0de2cbdd1\",\"contentHash\":\"9f0f78c0bca4f290fd840589af6caf67d96a281c96b1aae750928b3109786235\",\"evidenceSnapshotHash\":\"7f227db1653b6b723b07c8f2f6eb488f1f09e2f083ca7a3f5e02bbb274f5ff2e\",\"artifactFingerprint\":\"ebb6a30aa999af3ca8a225322e2ea0ca5c59ca1bdbdfcea8a3ae34c7e026b8aa\",\"path\":\"journal/zh-hant/articles/weekly-practice.md\",\"framework\":\"nextjs\",\"content\":\"---\\ntitle: \\\"每週練習測試\\\"\\nslug: \\\"weekly-practice\\\"\\nlanguage: \\\"zh-hant\\\"\\ncontentType: \\\"article\\\"\\npublicationId: \\\"publication-7\\\"\\nscheduleEntryId: \\\"entry-7\\\"\\nproductionPlanId: \\\"plan-3\\\"\\ndraftId: \\\"draft-5\\\"\\nreviewId: \\\"review-6\\\"\\nevidenceSnapshotHash: \\\"7f227db1653b6b723b07c8f2f6eb488f1f09e2f083ca7a3f5e02bbb274f5ff2e\\\"\\ncontentHash: \\\"9f0f78c0bca4f290fd840589af6caf67d96a281c96b1aae750928b3109786235\\\"\\npublishedAt: \\\"2026-10-03T00:00:00.000Z\\\"\\nauthoritySourceIds: [\\\"source-fixture\\\"]\\nappliedRuleIds: [\\\"rule-fixture\\\"]\\n---\\n這是一篇合成測試文章。\\n\\n## 練習記錄\\n\\n保持 **穩定**，記錄自己的感受。\",\"timestamp\":\"2026-10-04T00:00:00.000Z\",\"nonce\":\"fixture_nonce_00000001\",\"identity\":{\"publicationId\":\"publication-7\",\"ownerScopeKey\":\"owner-1\",\"scheduleEntryId\":\"entry-7\",\"productionPlanId\":\"plan-3\",\"productionDeliverableId\":\"publication-7\",\"jobId\":\"job-4\",\"draftId\":\"draft-5\",\"draftVersion\":2,\"reviewId\":\"review-6\",\"scheduleKey\":\"schedule-7\"},\"publication\":{\"title\":\"每週練習測試\",\"body\":\"這是一篇合成測試文章。\\n\\n## 練習記錄\\n\\n保持 **穩定**，記錄自己的感受。\",\"slug\":\"weekly-practice\",\"contentType\":\"article\",\"language\":\"zh-hant\",\"scheduledAt\":\"2026-10-03T00:00:00.000Z\",\"authoritySourceIds\":[\"source-fixture\"],\"ruleIds\":[\"rule-fixture\"],\"draftStage\":\"optimized\",\"reviewDecision\":\"approved_for_delivery\",\"riskGateStatus\":\"passed\"}}",
  "rawBodyHash": "5dd79abdb25bb76c84d532d7dfd01d13721d9825d121fcb1b4b3e51e92249b7c",
  "signatureInput": "first-party-signed-api-v2\nPOST\n/api/first-party/content-ingest\nhttps://doalignment.test\n5dd79abdb25bb76c84d532d7dfd01d13721d9825d121fcb1b4b3e51e92249b7c\n2026-10-04T00:00:00.000Z\nfixture_nonce_00000001",
  "signature": "262770f2d0d9684e576c6df72863630431858b0081ac5239ab85e03a26f0be3d"
} as const
function goldenInputs() {
  const { publicationId: _publicationId, ...identity } = GOLDEN.payload.identity
  const publication = makePublication({ ...identity, ...GOLDEN.payload.publication, contentHash: GOLDEN.payload.contentHash, evidenceSnapshotHash: GOLDEN.payload.evidenceSnapshotHash })
  const destination = makeSignedTarget({ framework: 'nextjs', targetId: GOLDEN.config.targetId, targetOrigin: GOLDEN.config.targetOrigin, ownerScopeKey: identity.ownerScopeKey, contentRoot: GOLDEN.config.contentRoot, credentialReference: GOLDEN.config.keyReference, allowedLanguages: ['zh-hant'] })
  return { publication, destination }
}
describe('Next.js sender receiver exact golden contract', () => {
  it('reproduces the receiver raw bytes, body hash, signature domain, artifact and idempotency exactly', async () => {
    const { publication, destination } = goldenInputs()
    const plan = planFirstPartyPublication(destination, publication, GOLDEN.payload.timestamp)
    if (plan.status !== 'planned') throw new Error('synthetic golden plan must be valid')
    expect(plan.artifact.artifactFingerprint).toBe(GOLDEN.payload.artifactFingerprint)
    expect(plan.artifact.path).toBe(GOLDEN.payload.path)
    expect(plan.command.idempotencyKey).toBe(GOLDEN.payload.idempotencyKey)
    const fetchImpl = vi.fn(async (_url, request) => {
      expect(request.body).toBe(GOLDEN.rawBody)
      expect(Buffer.from(request.body!, 'utf8')).toEqual(Buffer.from(GOLDEN.rawBody, 'utf8'))
      expect(createHash('sha256').update(request.body!, 'utf8').digest('hex')).toBe(GOLDEN.rawBodyHash)
      expect(request.headers['x-discoverystack-signature-version']).toBe(SIGNED_API_V2_VERSION)
      expect(request.headers['x-discoverystack-signature']).toBe(GOLDEN.signature)
      expect(request.headers['x-discoverystack-idempotency-key']).toBe(GOLDEN.payload.idempotencyKey)
      return response(200, { publicationId: GOLDEN.payload.publicationId, contentHash: GOLDEN.payload.contentHash, remoteRevision: 'golden-revision-001' })
    })
    const result = await executeFirstPartyPublication({ target: destination, publication, now: GOLDEN.payload.timestamp, mode: 'execute', fetchImpl, serverCredentialResolver: async () => ({ ok: true, value: GOLDEN.config.signingSecret }), nonceProvider: () => GOLDEN.payload.nonce })
    expect(result.status).toBe('delivered'); expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(GOLDEN.signatureInput).toBe([SIGNED_API_V2_VERSION, 'POST', '/api/first-party/content-ingest', GOLDEN.config.targetOrigin, GOLDEN.rawBodyHash, GOLDEN.payload.timestamp, GOLDEN.payload.nonce].join('\n'))
    expect(createHmac('sha256', GOLDEN.config.signingSecret).update(GOLDEN.signatureInput, 'utf8').digest('hex')).toBe(GOLDEN.signature)
  })
  it('retains the business identity with a fresh nonce/time and binds title edits into a new artifact/key', async () => {
    const { publication, destination } = goldenInputs()
    const a = planFirstPartyPublication(destination, publication, GOLDEN.payload.timestamp)
    const later = '2026-10-04T00:01:00.000Z'
    const b = planFirstPartyPublication(destination, publication, later)
    const edited = planFirstPartyPublication(destination, { ...publication, title: '另一個合成文章標題' }, later)
    if (a.status !== 'planned' || b.status !== 'planned' || edited.status !== 'planned') throw new Error('synthetic plans must be valid')
    expect(b.command.idempotencyKey).toBe(a.command.idempotencyKey)
    expect(edited.command.idempotencyKey).not.toBe(a.command.idempotencyKey); expect(edited.artifact.artifactFingerprint).not.toBe(a.artifact.artifactFingerprint)
    const validatedTarget = validateFirstPartyPublishTarget(destination)
    if (validatedTarget.status !== 'valid') throw new Error('synthetic target must be valid')
    const raw = buildSignedApiV2Body({ target: validatedTarget.target, publication, command: b.command, artifact: b.artifact, now: later, fetchImpl: vi.fn() }, later, 'fixture_nonce_00000002')
    expect(JSON.parse(raw).idempotencyKey).toBe(GOLDEN.payload.idempotencyKey)
    expect(buildSignedApiV2Signature(raw, destination.targetOrigin, GOLDEN.config.signingSecret, later, 'fixture_nonce_00000002')).not.toBe(GOLDEN.signature)
  })
})
describe('Next.js input and pre-transport receiver limits', () => {
  it('rejects unsupported target locale allowlists at the target guard', () => {
    for (const allowedLanguages of [['en'], ['zh-hant', 'en']]) expect(validateFirstPartyPublishTarget({ ...target(), allowedLanguages })).toMatchObject({ status: 'blocked', code: 'UNSUPPORTED_LANGUAGE' })
  })
  it('rejects a Next.js Git client and accepts its signed-api counterpart', () => {
    const client = { displayName: 'Synthetic Next client', canonicalSiteOrigin: 'https://doalignment.com', framework: 'nextjs', publicationTransport: 'first_party_signed_api', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '10:00', monthlyBudgetUnits: 4, idempotencyKey: 'synthetic-next-client' }
    expect(parseClientInput(client).framework).toBe('nextjs')
    expect(() => parseClientInput({ ...client, publicationTransport: 'first_party_git' })).toThrow()
  })
  it('limits parsed Next targets to the one signed article/locale route', () => {
    const input = { ...target(), idempotencyKey: 'synthetic-next-target', defaultBranch: null }
    const { targetId: _targetId, ownerScopeKey: _owner, status: _status, ...parsedInput } = input
    expect(parsePublicationTargetInput(parsedInput)).toMatchObject({ framework: 'nextjs', transport: 'first_party_signed_api', allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'] })
    for (const change of [{ transport: 'first_party_git', defaultBranch: 'main' }, { allowedContentTypes: ['faq'] }, { allowedLanguages: ['en'] }]) expect(() => parsePublicationTargetInput({ ...parsedInput, ...change })).toThrow()
  })
  it.each([{ title: '標'.repeat(161) }, { slug: 'ab' }, { slug: 'a'.repeat(101) }, { slug: 'media' }, { body: 'x'.repeat(24_001) }])('blocks an incompatible publication before resolving credentials or HTTP', async change => {
    const fetchImpl = vi.fn(), resolver = vi.fn(async () => ({ ok: true as const, value: secret }))
    const result = await executeFirstPartyPublication({ target: target(), publication: makePublication(change), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: resolver, nonceProvider: () => nonce })
    expect(result.status).toBe('blocked'); expect(fetchImpl).not.toHaveBeenCalled(); expect(resolver).not.toHaveBeenCalled()
  })
  it('accepts exact title/slug upper boundaries without truncating the approved values', async () => {
    const publication = makePublication({ title: '標'.repeat(160), slug: 'a'.repeat(100) })
    const fetchImpl = vi.fn(async (_url, request) => { expect(JSON.parse(request.body!).publication).toMatchObject({ title: publication.title, slug: publication.slug }); return response(200, { publicationId: publication.productionDeliverableId, contentHash: publication.contentHash, remoteRevision: 'boundary-revision-001' }) })
    expect((await executeFirstPartyPublication({ target: target(), publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: async () => ({ ok: true, value: secret }), nonceProvider: () => nonce })).status).toBe('delivered')
  })
  it.each(['short-synthetic-key', 'synthetic-only-key-with-whitespace-00000 '])('rejects receiver-incompatible key format before HTTP', async key => {
    const fetchImpl = vi.fn()
    const result = await executeFirstPartyPublication({ target: target(), publication: makePublication(), now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: async () => ({ ok: true, value: key }), nonceProvider: () => nonce })
    expect(result).toMatchObject({ status: 'blocked', code: 'CREDENTIAL_MISSING' }); expect(fetchImpl).not.toHaveBeenCalled()
  })
})
