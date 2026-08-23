import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOGEO_UPSTREAM, buildOfficialAutoGeoPrompt, createAutoGeoApiAdapter } from '../server/geo/autogeo-api'
import { assertSafeHttpsOrigin } from '../server/audit/targetGuard'
import { createAutoGeoBailianQwenAdapter, isAllowedBailianEndpoint } from '../server/geo/autogeo-bailian-qwen'
import type { GeoRewriteAdapter } from '../server/geo/contracts'
import { optimiseGeoDocument, referenceRulesAdapter } from '../server/geo/optimise'
import { assertSourceBoundRewrite, AutoGeoUnsafeOutputError } from '../server/geo/output-safety'
import { geoRules } from '../server/geo/rules'

const input = { title: '網站可讀性改善', content: '這份說明介紹如何整理服務頁資訊，讓讀者理解服務內容與下一步。', language: 'zh-hant' as const }

describe('GEO Workbench V1 contract', () => {
  beforeEach(() => { vi.stubEnv('NUXT_AUTOGEO_BAILIAN_API_KEY', ''); vi.stubEnv('NUXT_AUTOGEO_BAILIAN_ENDPOINT', ''); vi.stubEnv('NUXT_AUTOGEO_BAILIAN_MODEL', ''); vi.stubEnv('NUXT_AUTOGEO_GEMINI_API_KEY', '') })
  afterEach(() => vi.unstubAllEnvs())

  it('uses a transparent reference fallback when server-side providers are unavailable', async () => {
    const result = await optimiseGeoDocument(input)
    expect(result.candidate.provider).toBe('reference-rules-v1')
    expect(result.candidate.provenance.execution).toBe('reference-fallback')
    expect(result.candidate.provenance.fallbackReason).toBe('bailian-not-configured')
    expect(result.candidate.optimizedContent).toContain(input.content)
    expect(result.candidate.appliedRuleIds).toContain('claim-safety')
    expect(result.interpretationLimit).toContain('不代表')
  })

  it('includes server-resolved approved evidence context in the provider prompt and safety source', () => {
    const document = { ...input, approvedEvidenceContext: 'Approved evidence: 我們協助客戶提升流量。', approvedBriefGoals: ['回答受眾的核心問題'], approvedBriefConstraints: ['不得捏造成效'] }
    expect(buildOfficialAutoGeoPrompt(document)).toContain('Approved evidence context')
    expect(buildOfficialAutoGeoPrompt(document)).toContain(document.approvedEvidenceContext)
    expect(buildOfficialAutoGeoPrompt(document)).toContain('回答受眾的核心問題')
    expect(buildOfficialAutoGeoPrompt(document)).toContain('不得捏造成效')
    expect(() => assertSourceBoundRewrite(document, document.title, '我們協助客戶提升流量。')).not.toThrow()
    expect(() => assertSourceBoundRewrite(input, input.title, '我們協助客戶提升流量。')).toThrow(AutoGeoUnsafeOutputError)
  })

  it('only accepts documented HTTPS Model Studio compatible endpoint shapes', () => {
    expect(isAllowedBailianEndpoint('https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions')).toBe(true)
    expect(isAllowedBailianEndpoint('https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions')).toBe(true)
    expect(isAllowedBailianEndpoint('http://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions')).toBe(false)
    expect(isAllowedBailianEndpoint('https://evil.example/compatible-mode/v1/chat/completions')).toBe(false)
    expect(isAllowedBailianEndpoint('https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions?redirect=https://evil.example')).toBe(false)
  })

  it('does not construct a Bailian request for missing or invalid settings', () => {
    expect(() => createAutoGeoBailianQwenAdapter({ apiKey: 'test-only-key' })).toThrow(/configuration/i)
    expect(() => createAutoGeoBailianQwenAdapter({ apiKey: 'test-only-key', endpoint: 'https://example.com/compatible-mode/v1/chat/completions' })).toThrow(/configuration/i)
  })

  it('uses the official AutoGEO prompt through Qwen while returning only non-sensitive provenance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: '這是以百煉 Qwen 產生的改寫內容。' } }], usage: { prompt_tokens: 101, completion_tokens: 55, total_tokens: 156 } }), { status: 200 }))
    const adapter = createAutoGeoBailianQwenAdapter({ apiKey: 'test-only-key', endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', fetchImpl, requestIdFactory: () => 'geo-test-request-id' })
    const result = await optimiseGeoDocument(input, adapter)
    expect(result.candidate.provider).toBe('autogeo-bailian-qwen')
    expect(result.candidate.provenance.execution).toBe('autogeo-framework-bailian-qwen')
    expect(result.candidate.provenance).not.toHaveProperty('providerRequestId')
    expect(result.candidate.provenance.usage).toEqual({ inputTokens: 101, outputTokens: 55, totalTokens: 156 })
    const request = fetchImpl.mock.calls[0]?.[1]
    const payload = JSON.parse(String(request?.body))
    expect(payload.messages[0].content).toContain('maximizes its visibility and impact')
    expect(payload.messages[0].content).toContain(input.title)
    expect(payload.messages[0].content).toContain('Source-bound safety overlay')
    expect(request?.headers).toMatchObject({ authorization: 'Bearer test-only-key', 'x-discoverystack-request-id': 'geo-test-request-id' })
  })

  it('rejects an unsupported customer-success or commercial-outcome claim from the provider', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: '成功案例：我們已經幫助多家企業提高轉換率與線上表現。' } }] }), { status: 200 }))
    const adapter = createAutoGeoBailianQwenAdapter({ apiKey: 'test-only-key', endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', fetchImpl })
    await expect(adapter.rewrite(input, [])).rejects.toBeInstanceOf(AutoGeoUnsafeOutputError)
    const result = await optimiseGeoDocument(input, adapter)
    expect(result.candidate.provider).toBe('reference-rules-v1')
    expect(result.candidate.provenance.fallbackReason).toBe('provider-output-safety-rejected')
    expect(result.candidate.safetyNotes.join(' ')).toContain('source-bound guard')
  })

  it('rejects the observed Simplified-Chinese case-study template with quantified outcomes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-max', choices: [{ message: { content: '# 服务概述\n\n## 成功案例\n- **ABC公司**：三个月内将在线咨询量提升了30%。\n\n我们拥有经验丰富的顾问团队。' } }] }), { status: 200 }))
    const adapter = createAutoGeoBailianQwenAdapter({ apiKey: 'test-only-key', endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', fetchImpl })
    const result = await optimiseGeoDocument(input, adapter)
    expect(result.candidate.provenance.fallbackReason).toBe('provider-output-safety-rejected')
    expect(result.candidate.optimizedContent).toContain(input.content)
  })

  it('rejects provider failure instead of returning a false success candidate', async () => {
    const adapter = createAutoGeoBailianQwenAdapter({ apiKey: 'test-only-key', endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 503 })) })
    await expect(optimiseGeoDocument(input, adapter)).rejects.toMatchObject({ name: 'AutoGeoBailianProviderError', issue: 'upstream' })
  })

  it('uses a transparent fallback when an unsafe-output error crosses a module boundary', async () => {
    const adapter: GeoRewriteAdapter = { id: 'custom', version: 'test', async rewrite() { const error = new Error('provider output is unsafe'); error.name = 'AutoGeoUnsafeOutputError'; throw error } }
    const result = await optimiseGeoDocument(input, adapter)
    expect(result.candidate.provider).toBe('reference-rules-v1')
    expect(result.candidate.provenance.fallbackReason).toBe('provider-output-safety-rejected')
    expect(result.candidate.safetyNotes.join(' ')).toContain('reference-rules-v1 fallback')
  })

  it('recognises a serialised source-bound rejection after a runtime module boundary', async () => {
    const error = new Error('The provider rewrite contains unsupported commercial or customer-success claims.')
    const { isUnsafeProviderRewrite } = await import('../server/geo/optimise')
    expect(isUnsafeProviderRewrite(error)).toBe(true)
  })

  it('uses the complete official AutoGEO API prompt when a server-side credential is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '這是經完整 AutoGEO API 改寫的內容。' }] } }] }), { status: 200 }))
    const result = await optimiseGeoDocument(input, createAutoGeoApiAdapter({ apiKey: 'test-only-key', fetchImpl }))
    expect(result.candidate.provenance.execution).toBe('official-autogeo-api')
    expect(result.candidate.provenance.upstreamRevision).toBe(AUTOGEO_UPSTREAM.revision)
    const request = fetchImpl.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body)).contents[0].parts[0].text).toContain('Attribute all factual claims to credible, authoritative sources with clear citations.')
  })

  it('applies selected reference rules as observable deterministic body transformations', async () => {
    const byId = (id: string) => geoRules.filter(rule => rule.id === id)
    const direct = await optimiseGeoDocument(input, referenceRulesAdapter, byId('direct-answer-first'))
    const faq = await optimiseGeoDocument(input, referenceRulesAdapter, byId('faq-question-answer'))
    const headings = await optimiseGeoDocument(input, referenceRulesAdapter, byId('heading-hierarchy'))
    const citation = await optimiseGeoDocument(input, referenceRulesAdapter, byId('citation-readiness'))
    expect(direct.candidate.optimizedContent).toContain('## 直接摘要')
    expect(faq.candidate.optimizedContent).toContain('## 問題與回答')
    expect(headings.candidate.optimizedContent).toContain(`# ${input.title}`)
    expect(citation.candidate.optimizedContent).toContain('## 引用準備')
    expect(direct.candidate.optimizedContent).not.toEqual(faq.candidate.optimizedContent)
    expect(faq.candidate.optimizedContent).not.toEqual(headings.candidate.optimizedContent)
    expect(headings.candidate.optimizedContent).not.toEqual(citation.candidate.optimizedContent)
  })

  it('has a deterministic body transformation for every canonical reference rule', async () => {
    for (const rule of geoRules) {
      const result = await optimiseGeoDocument(input, referenceRulesAdapter, [rule])
      expect(result.candidate.appliedRuleIds).toEqual([rule.id])
      expect(result.candidate.optimizedContent).not.toBe(result.original.content)
    }
  })

  it('passes only selected canonical rules to the adapter and candidate provenance', async () => {
    const selected = geoRules.filter(rule => ['direct-answer-first', 'claim-safety'].includes(rule.id))
    const adapter: GeoRewriteAdapter = { id: 'custom', version: 'selected-rule-test', async rewrite(document, rules) { return { provider: 'custom', providerVersion: 'selected-rule-test', optimizedTitle: document.title, optimizedContent: document.content, appliedRuleIds: rules.map(rule => rule.id), safetyNotes: [], provenance: { requestedProvider: 'autogeo-api', execution: 'reference-fallback', upstreamRepository: 'cxcscmu/AutoGEO', upstreamRevision: 'test', rewriteMethod: 'autogeo_api', ruleset: 'Researchy-GEO / Gemini default rules', model: 'test' } } } }
    const result = await optimiseGeoDocument(input, adapter, selected)
    expect(result.candidate.appliedRuleIds).toEqual(['direct-answer-first', 'claim-safety'])
    expect(result.candidate.appliedRuleIds).not.toContain('semantic-sections')
    const prompt = buildOfficialAutoGeoPrompt(input, selected)
    expect(prompt).toContain('Selected canonical strategy rules')
    expect(prompt).not.toContain(String.raw`\n`)
  })

  it('rejects oversize input before an adapter runs', async () => {
    await expect(optimiseGeoDocument({ title: '標題', content: 'x'.repeat(12001), language: 'zh-hant' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(optimiseGeoDocument({ title: '標題', content: '足夠長的原文內容。'.repeat(30), language: 'zh-hant', approvedEvidenceContext: 'x'.repeat(16001) })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('requires HTTPS for delivery target origins while retaining the general audit guard', () => {
    expect(assertSafeHttpsOrigin('https://cms.example.com/path').normalizedUrl).toBe('https://cms.example.com/path')
    expect(() => assertSafeHttpsOrigin('http://cms.example.com/path')).toThrow(/HTTPS/i)
  })
})
