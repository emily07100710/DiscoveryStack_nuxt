import type { GeoDocumentInput, GeoRewriteAdapter } from '../geo/contracts'
import type { AutoGeoStrategyRule, ContentDraftGenerationInput, ContentDraftGenerationResult, EvidenceMaterial } from './contracts'

const MAX_MATERIAL_LENGTH = 5000

function firstSentence(value: string): string {
  return (value.split(/[。！？.!?]/u).map(part => part.trim()).find(Boolean) || value).slice(0, 360).trim()
}

function materialText(materials: EvidenceMaterial[]): string {
  return materials.filter(material => material.reviewedText.trim()).map(material => {
    const label = material.sourceName || material.locator || `source-${material.sourceId}`
    return `${label}: ${material.reviewedText.slice(0, MAX_MATERIAL_LENGTH)}`
  }).join('\n\n')
}

function evidenceNotice(language: ContentDraftGenerationInput['language']): string {
  return language === 'zh-hant'
    ? '本文只整理 server 端重新解析且已核准的 evidence。未提供的事實、案例、數據、排名、流量、轉換、營收與 ROI 不得由本文推導。'
    : 'This draft uses only evidence re-resolved and approved by the server. Do not infer facts, cases, statistics, rankings, traffic, conversion, revenue or ROI that are not supplied.'
}

function scaffoldFor(input: ContentDraftGenerationInput): ContentDraftGenerationResult {
  const evidence = materialText(input.evidenceMaterials)
  const sourceSummary = evidence ? firstSentence(evidence) : ''
  const limitation = input.language === 'zh-hant'
    ? '這是 deterministic scaffold，不是完整 AI 文章；發布前必須由 owner 補充與核對所有必要內容。'
    : 'This is a deterministic scaffold, not a complete AI article; the owner must complete and verify it before publication.'
  const goalLines = input.goals.length ? input.goals.map(goal => `- ${goal}`).join('\n') : '- 依核准的內容機會整理可核對的主題'
  const constraintLines = input.constraints.length ? input.constraints.map(constraint => `- ${constraint}`).join('\n') : '- 只使用 approved evidence'
  const evidenceSection = evidence || (input.language === 'zh-hant' ? '目前沒有足夠 reviewed evidence text；不得把 Brief metadata 當成事實內容。' : 'There is not enough reviewed evidence text; do not treat Brief metadata as factual content.')

  if (input.language === 'zh-hant') {
    const body = input.contentType === 'faq'
      ? `# ${input.title}\n\n## FAQ 範圍\n${sourceSummary || '本 FAQ 的範圍需要 owner 依 approved evidence 補充。'}\n\n## 常見問題與回答\n### 目前可以由核准資料確認什麼？\n${evidenceSection}\n\n### 哪些內容仍需人工確認？\n${limitation}\n\n## 目標\n${goalLines}\n\n## 限制\n${constraintLines}\n\n## Evidence 摘要\n${evidenceSection}\n\n${evidenceNotice(input.language)}`
      : input.contentType === 'service_page'
        ? `# ${input.title}\n\n## 服務摘要\n${sourceSummary || '請由 owner 依 approved evidence 完成服務摘要。'}\n\n## 適用範圍與受眾\n本頁面面向：${input.audience}\n\n## 可由 evidence 支持的說明\n${evidenceSection}\n\n## 服務目標\n${goalLines}\n\n## 使用限制與人工核對\n${constraintLines}\n\n${limitation}\n\n${evidenceNotice(input.language)}`
        : `# ${input.title}\n\n## 直接摘要\n${sourceSummary || '請由 owner 依 approved evidence 補入可核對的直接摘要。'}\n\n## 主題與適用範圍\n本文章面向：${input.audience}\n\n## 詳細說明\n${evidenceSection}\n\n## 文章目標\n${goalLines}\n\n## 內容限制\n${constraintLines}\n\n## 人工核對\n${limitation}\n\n${evidenceNotice(input.language)}`
    return { title: input.title, body, mode: 'deterministic_scaffold', provider: 'discoverystack-deterministic-scaffold', providerVersion: 'content-scaffold-v1', provenance: { generator: 'discoverystack-deterministic-scaffold', contentType: input.contentType, evidenceMaterialCount: input.evidenceMaterials.length }, limitations: [limitation, evidenceNotice(input.language)] }
  }

  const body = input.contentType === 'faq'
    ? `# ${input.title}\n\n## FAQ scope\n${sourceSummary || 'The owner must complete this scope from approved evidence.'}\n\n## Questions and answers\n### What can the approved material support?\n${evidenceSection}\n\n### What still needs human verification?\n${limitation}\n\n## Goals\n${goalLines}\n\n## Constraints\n${constraintLines}\n\n## Evidence summary\n${evidenceSection}\n\n${evidenceNotice(input.language)}`
    : input.contentType === 'service_page'
      ? `# ${input.title}\n\n## Service summary\n${sourceSummary || 'The owner must complete this summary from approved evidence.'}\n\n## Audience and scope\nThis page is for: ${input.audience}\n\n## Evidence-supported description\n${evidenceSection}\n\n## Service goals\n${goalLines}\n\n## Constraints and human verification\n${constraintLines}\n\n${limitation}\n\n${evidenceNotice(input.language)}`
      : `# ${input.title}\n\n## Direct summary\n${sourceSummary || 'The owner must complete this summary from approved evidence.'}\n\n## Topic and scope\nThis article is for: ${input.audience}\n\n## Detailed explanation\n${evidenceSection}\n\n## Article goals\n${goalLines}\n\n## Content constraints\n${constraintLines}\n\n## Human verification\n${limitation}\n\n${evidenceNotice(input.language)}`
  return { title: input.title, body, mode: 'deterministic_scaffold', provider: 'discoverystack-deterministic-scaffold', providerVersion: 'content-scaffold-v1', provenance: { generator: 'discoverystack-deterministic-scaffold', contentType: input.contentType, evidenceMaterialCount: input.evidenceMaterials.length }, limitations: [limitation, evidenceNotice(input.language)] }
}

function providerDocument(input: ContentDraftGenerationInput): GeoDocumentInput {
  return {
    title: input.title,
    content: [`Content type: ${input.contentType}`, `Audience: ${input.audience}`, 'Approved evidence materials:', materialText(input.evidenceMaterials) || 'No reviewed evidence text is available.', 'The provider is generating a base draft, not a publication or performance claim.'].join('\n\n'),
    language: input.language,
    approvedEvidenceContext: materialText(input.evidenceMaterials).slice(0, 16000),
    approvedDiagnosisContext: JSON.stringify(input.diagnosisFindings).slice(0, 12000),
    approvedStrategyContext: JSON.stringify(input.strategyRules).slice(0, 16000),
    approvedBriefGoals: input.goals,
    approvedBriefConstraints: input.constraints,
  }
}

export function createDeterministicScaffoldGenerator(): ContentDraftGenerator {
  return { id: 'discoverystack-deterministic-scaffold', version: 'content-scaffold-v1', async generate(input) { return scaffoldFor(input) } }
}

export type ContentDraftProvider = {
  id: string
  version: string
  generate: (document: GeoDocumentInput) => Promise<{ title: string, body: string, provider: string, providerVersion: string, provenance: Record<string, unknown>, limitations: string[] }>
}

export function createGeoRewriteContentDraftProvider(adapter: GeoRewriteAdapter): ContentDraftProvider {
  return {
    id: `content-provider:${adapter.id}`,
    version: adapter.version,
    async generate(document) {
      const result = await adapter.rewrite(document, [])
      return {
        title: result.optimizedTitle || document.title,
        body: result.optimizedContent,
        provider: result.provider,
        providerVersion: result.providerVersion,
        provenance: { ...result.provenance, role: 'content-draft-provider', appliedRuleIds: [] },
        limitations: ['Provider base draft remains a draft and must pass risk gate and owner review before preview or export.'],
      }
    },
  }
}

export function createProviderContentDraftGenerator(provider: ContentDraftProvider): ContentDraftGenerator {
  return {
    id: provider.id,
    version: provider.version,
    async generate(input) {
      const result = await provider.generate(providerDocument(input))
      return {
        title: result.title || input.title,
        body: result.body,
        mode: 'provider_draft',
        provider: result.provider,
        providerVersion: result.providerVersion,
        provenance: { ...result.provenance, stage: 'base_draft', generationMode: 'provider_draft', providerRole: 'content-draft-generator' },
        limitations: result.limitations,
      }
    },
  }
}

export type ContentDraftGenerator = {
  id: string
  version: string
  generate: (input: ContentDraftGenerationInput) => Promise<ContentDraftGenerationResult>
}

export function buildEvidenceMaterialContext(materials: EvidenceMaterial[]): string {
  return materialText(materials).slice(0, 16000)
}

export function buildOptimizationDocument(input: { title: string, body: string, language: 'en' | 'zh-hant', goals: string[], constraints: string[], diagnosisFindings: unknown[], strategyRules: AutoGeoStrategyRule[], evidenceMaterials: EvidenceMaterial[] }): GeoDocumentInput {
  return {
    title: input.title,
    content: input.body,
    language: input.language,
    approvedEvidenceContext: buildEvidenceMaterialContext(input.evidenceMaterials),
    approvedDiagnosisContext: JSON.stringify(input.diagnosisFindings).slice(0, 12000),
    approvedStrategyContext: JSON.stringify(input.strategyRules).slice(0, 16000),
    approvedBriefGoals: input.goals,
    approvedBriefConstraints: input.constraints,
  }
}
