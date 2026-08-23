import { describe, expect, it } from 'vitest'
import { createDeterministicScaffoldGenerator, createGeoRewriteContentDraftProvider, createProviderContentDraftGenerator } from '../server/seo-geo-core/contentGenerator'
import type { GeoRewriteAdapter } from '../server/geo/contracts'
import type { ContentDraftGenerationInput } from '../server/seo-geo-core/contracts'

const base = (contentType: ContentDraftGenerationInput['contentType']): ContentDraftGenerationInput => ({
  contentType,
  title: 'Evidence-led content',
  audience: '研究者',
  language: 'zh-hant',
  goals: ['回答主題'],
  constraints: ['只使用 approved evidence'],
  diagnosisFindings: [],
  strategyRules: [],
  evidenceMaterials: [{ sourceId: 1, artifactId: 2, sourceName: 'Reviewed source', artifactType: 'html', artifactHash: 'hash', reviewedText: '這是已核准且可核對的來源內容，描述主題、範圍與方法。' }],
})

describe('deterministic evidence-bound base draft generator', () => {
  it.each([
    ['article', '直接摘要', '詳細說明'],
    ['faq', '常見問題與回答', 'Evidence 摘要'],
    ['service_page', '服務摘要', '可由 evidence 支持的說明'],
  ] as const)('creates a structured %s draft from reviewed artifact text', async (contentType, firstHeading, secondHeading) => {
    const result = await createDeterministicScaffoldGenerator().generate(base(contentType))
    expect(result.mode).toBe('deterministic_scaffold')
    expect(result.body).toContain('這是已核准且可核對的來源內容')
    expect(result.body).toContain(firstHeading)
    expect(result.body).toContain(secondHeading)
    expect(result.provenance.contentType).toBe(contentType)
  })

  it('keeps the base provider role separate from selected-rule optimization', async () => {
    const adapter: GeoRewriteAdapter = { id: 'autogeo-api', version: 'provider-v1', async rewrite(document, rules) { expect(rules).toHaveLength(0); return { provider: 'autogeo-api', providerVersion: 'provider-v1', optimizedTitle: document.title, optimizedContent: `# ${document.title}\n\n${document.content}\n\n## Provider base section\n完整 provider base draft`, appliedRuleIds: [], safetyNotes: [], provenance: { requestedProvider: 'autogeo-api', execution: 'reference-fallback', upstreamRepository: 'cxcscmu/AutoGEO', upstreamRevision: 'test', rewriteMethod: 'autogeo_api', ruleset: 'Researchy-GEO / Gemini default rules', model: 'test' } } } }
    const result = await createProviderContentDraftGenerator(createGeoRewriteContentDraftProvider(adapter)).generate(base('article'))
    expect(result.mode).toBe('provider_draft')
    expect(result.provenance.providerRole).toBe('content-draft-generator')
    expect(result.provenance.stage).toBe('base_draft')
    expect(result.body).toContain('Provider base section')
  })

  it('does not turn missing artifact text into a factual metadata draft', async () => {
    const result = await createDeterministicScaffoldGenerator().generate({ ...base('article'), evidenceMaterials: [{ ...base('article').evidenceMaterials[0]!, reviewedText: '' }] })
    expect(result.body).toContain('不得把 Brief metadata 當成事實內容')
    expect(result.limitations.join(' ')).toContain('deterministic scaffold')
  })
})
