import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { GEOFLOW_PROTOCOL_VERSION } from '../server/geoflow-integration'
import { createGeoFlowQwenGenerationRuntime } from '../server/geoflow-runtime/qwen'

const reviewedText = '核准的 synthetic evidence：這是一段可由 owner 查核的內容。'
const normalizedReviewedText = reviewedText.normalize('NFKC').trim().replace(/\s+/gu, ' ')
const chunkHash = createHash('sha256').update(Buffer.from(normalizedReviewedText, 'utf8')).digest('hex')
const evidenceSnapshotHash = 'a'.repeat(64)
const endpoint = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions'

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: GEOFLOW_PROTOCOL_VERSION,
    requestId: 'request-1',
    idempotencyKey: 'idempotency-1',
    ownerUserId: 7,
    clientId: 11,
    calendarEntryId: 13,
    productionPlanId: 17,
    deliverableId: 19,
    briefId: 23,
    jobId: 29,
    evidenceSnapshotHash,
    brief: { title: '核准內容主題', audience: '內容 owner', goals: ['回答核心問題'], constraints: ['不得新增未核准主張'] },
    contentType: 'article',
    language: 'zh-hant',
    generationMode: 'draft',
    revisionContext: null,
    requestedCapabilities: ['qwen_generation', 'knowledge_rag', 'human_review'],
    selectedRuleIds: [],
    authoritySourceIds: ['source-1'],
    evidenceChunks: [{ sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', chunkHash, reviewedText, locator: 'https://evidence.routing.discoverystack.dev/section-1' }],
    createdAt: '2026-08-25T04:00:00Z',
    ...overrides,
  }
}

function runtime(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof createGeoFlowQwenGenerationRuntime>[0]> = {}) {
  return createGeoFlowQwenGenerationRuntime({ endpoint, credentialRef: 'credential:qwen-test', resolveCredential: async ref => ref === 'credential:qwen-test' ? 'fake-placeholder-secret' : undefined, fetchImpl, now: () => '2026-08-25T04:01:00Z', ...overrides })
}

describe('GEOFlow Qwen generation runtime', () => {
  it('returns a validated review-required draft with non-sensitive provider provenance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: '# 核准內容主題\n\n這是只根據核准資料整理的草稿。' } }], usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 } }), { status: 200 }))
    const result = await runtime(fetchImpl).generate(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('review_required')
    if (result.value.status !== 'review_required') return
    expect(result.value.externalArticleKey).toBe('article-13-19')
    expect(result.value.draftIdentity.briefFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.value.contentArtifact.bodyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.value.providerProvenance).toEqual({ provider: 'bailian', model: 'qwen-plus', mode: 'provider', fallbackReason: null })
    expect(JSON.stringify(result.value)).not.toContain('fake-placeholder-secret')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error' })
  })

  it('blocks before provider execution when the opaque credential cannot be resolved', async () => {
    const fetchImpl = vi.fn()
    const resolver = vi.fn().mockResolvedValue(undefined)
    const result = await runtime(fetchImpl, { resolveCredential: resolver }).generate(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('blocked')
    if (result.value.status !== 'blocked') return
    expect(result.value.failure.retryable).toBe(false)
    expect(result.value.failure.code).toBe('IDENTITY_MISMATCH')
    expect(resolver).toHaveBeenCalledWith('credential:qwen-test')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('blocks invalid endpoints without resolving credentials or making a request', async () => {
    const fetchImpl = vi.fn()
    const resolver = vi.fn().mockResolvedValue('fake-placeholder-secret')
    const result = await runtime(fetchImpl, { endpoint: 'https://evil.example/compatible-mode/v1/chat/completions', resolveCredential: resolver }).generate(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('blocked')
    expect(resolver).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps AutoGEO optimization separate from Qwen base-draft generation', async () => {
    const fetchImpl = vi.fn()
    const result = await runtime(fetchImpl).generate(request({ requestedCapabilities: ['qwen_generation', 'autogeo_optimization'], selectedRuleIds: ['direct-answer-first'] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('blocked')
    if (result.value.status !== 'blocked') return
    expect(result.value.failure.code).toBe('REQUIRED_RULE_MISSING')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('blocks source-bound unsafe provider output instead of returning a draft', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '成功案例：我們協助客戶提高轉換率。' } }] }), { status: 200 }))
    const result = await runtime(fetchImpl).generate(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('blocked')
    if (result.value.status !== 'blocked') return
    expect(result.value.failure.code).toBe('PROVIDER_PROVENANCE_MISSING')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns a retryable failed response for provider 429 without a content artifact', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 429 }))
    const result = await runtime(fetchImpl, { attempt: 2 }).generate(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('failed')
    if (result.value.status !== 'failed') return
    expect(result.value.failure.retryable).toBe(true)
    expect(result.value.attempt).toBe(2)
  })

  it('blocks NUL-containing provider content without retrying or returning an artifact', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '核准內容\u0000不可接受' } }] }), { status: 200 }))
    const result = await runtime(fetchImpl).generate(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('blocked')
    if (result.value.status !== 'blocked') return
    expect(result.value.failure.retryable).toBe(false)
    expect(result.value.failure.code).toBe('INVALID_INPUT')
    expect('contentArtifact' in result.value).toBe(false)
  })

  it('rejects malformed request input before any provider resolution', async () => {
    const fetchImpl = vi.fn()
    const resolver = vi.fn().mockResolvedValue('fake-placeholder-secret')
    const result = await runtime(fetchImpl, { resolveCredential: resolver }).generate({ ...request(), unknownField: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('UNKNOWN_FIELD')
    expect(resolver).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
