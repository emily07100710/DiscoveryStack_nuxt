import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 2070001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/prevent-images-on-your-page?hl=zh-cn',
    sourceLocator: 'human-review:batch-39:remove-images-hosted-on-site',
    artifactText: 'Google distinguishes temporary emergency image removal from durable exclusion. For images hosted on a site, publishers can use targeted Googlebot-Image robots.txt disallow rules or a noindex X-Robots-Tag HTTP header. Googlebot must be able to crawl an image URL to read a noindex header, and blocking a page-level image differs from preventing a shared image from being indexed wherever it appears. The Removals tool can expedite a result change, but images can reappear after expiry when their underlying availability or indexing controls are not changed.',
    qualityNote: '人工閱讀 Remove images hosted on your site from search results：摘要保留 temporary versus durable removal、Googlebot-Image robots rules、X-Robots-Tag crawl requirement、shared-image scope與 Removals expiry 邊界；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['service', 'tool', 'editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['image removal', 'Googlebot-Image', 'robots.txt', 'X-Robots-Tag', 'emergency removals', 'indexing controls'],
      entitySignals: [
        { name: 'Googlebot-Image', type: 'service', relationship: 'Processes image crawling rules that can control whether hosted images remain eligible for Google Images.' },
        { name: 'X-Robots-Tag', type: 'concept', relationship: 'Provides an HTTP-header noindex control that requires crawl access for Googlebot to observe.' },
        { name: 'Removals tool', type: 'service', relationship: 'Can accelerate temporary result suppression but does not replace durable content or indexing controls.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'high',
      annotationRationale: '此頁提供影像可見性、暫時移除與持久技術控制的可驗證步驟，適合作為回應後續搜尋呈現問題並推進技術修正的多維樣本。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2070002,
    sourceUrl: 'https://developers.google.com/search/docs/essentials/spam-policies',
    sourceLocator: 'human-review:batch-39:spam-policies',
    artifactText: 'Google Search spam policies describe practices that deceive users or manipulate Search systems, including cloaking, doorway abuse, expired-domain abuse, hacked-content injection, hidden text or links, keyword stuffing, link spam, machine-generated traffic and malicious practices. Enforcement can be automated and supported by human review, and policy violations can lower visibility or remove pages from Search. Accessible content for users and search engines, transparent paid-link qualification, secure site operation and a clearly useful hierarchy are recurring safeguards; an implementation must be evaluated against the policy rather than treated as a guaranteed ranking mechanism.',
    qualityNote: '人工閱讀 Spam policies for Google web search：摘要保留主要 spam 類別、自動與人工執法、可見性後果、cloaking／link qualification／security safeguards與非保證 ranking 邊界；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding',
      journeyStages: ['discovery', 'understanding', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service'], audienceRoles: ['decision_maker', 'practitioner', 'technical_evaluator', 'researcher'],
      topicClusters: ['search spam policies', 'cloaking', 'link spam', 'hacked content', 'quality enforcement', 'people-first visibility'],
      entitySignals: [
        { name: 'Google Search spam policies', type: 'concept', relationship: 'Defines behaviors that can reduce visibility or remove content when they manipulate Search systems or users.' },
        { name: 'Google Search', type: 'service', relationship: 'Uses automated systems and, where needed, human review to enforce policy against spam practices.' },
        { name: 'Link qualification', type: 'concept', relationship: 'Separates normal advertising or sponsorship from ranking-manipulative link arrangements.' },
      ],
      geoSignals: ['global', 'country', 'region'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'information_overload'], actionPriority: 'high',
      annotationRationale: '此頁將政策風險、可見性後果、內容品質與技術／安全實作連結到多受眾決策，能支援 SEO/GEO 模型辨識合規與信任訊號。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2070003,
    sourceUrl: 'https://developers.google.com/search/docs/essentials/technical?hl=pl',
    sourceLocator: 'human-review:batch-39:technical-requirements',
    artifactText: 'Google Search technical requirements set three minimum conditions for indexing eligibility: Googlebot must not be blocked, the page must return HTTP 200, and it must have indexable content. Meeting these conditions does not guarantee indexing. Search Console Page Indexing and Crawl Stats reports can reveal inaccessible URLs, while URL Inspection can check a particular page. Robots.txt blocking can prevent crawling without reliably preventing a URL from appearing, so noindex requires Google to be able to crawl the URL and process the directive.',
    qualityNote: '人工閱讀 Google Search technical requirements：摘要保留 Googlebot access、HTTP 200、indexable content、eligibility 非 guarantee、Page Indexing/Crawl Stats/URL Inspection 與 robots versus noindex 邊界；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['service', 'tool', 'editorial'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker', 'researcher'],
      topicClusters: ['technical requirements', 'Googlebot access', 'HTTP 200', 'indexable content', 'URL Inspection', 'robots and noindex'],
      entitySignals: [
        { name: 'Googlebot', type: 'service', relationship: 'Must be able to discover and access a public page before Search can assess indexing eligibility.' },
        { name: 'URL Inspection tool', type: 'service', relationship: 'Supports page-specific diagnosis of crawl, index and serving conditions.' },
        { name: 'Page Indexing report', type: 'service', relationship: 'Helps identify groups of URLs that are inaccessible or not indexed.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'critical',
      annotationRationale: '此頁把可檢索性、成功 HTTP 狀態與可索引內容轉為可操作的技術診斷順序，並明示最小門檻不等於呈現保證，適合作為 response 標註。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 2070004,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/spam-updates?hl=ja',
    sourceLocator: 'human-review:batch-39:spam-updates',
    artifactText: 'Google Search uses automated systems to detect spam continuously and periodically announces notable improvements as spam updates. A site that changes after such an update should review the spam policies, correct violations, and allow time for systems to learn whether the site complies. Link-spam updates may remove prior ranking benefit from manipulative links; fixing the issue does not restore that former benefit. The document frames monitoring as policy-driven remediation and expectation setting, not as a promise of rapid recovery.',
    qualityNote: '人工閱讀 Google Search spam updates and your site：摘要保留持續自動偵測、notable update、policy review、time-to-reassessment、link-spam benefit non-restoration與非保證 recovery；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response',
      journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service'], audienceRoles: ['decision_maker', 'practitioner', 'technical_evaluator', 'researcher'],
      topicClusters: ['spam updates', 'SpamBrain', 'policy remediation', 'traffic change diagnosis', 'link spam', 'ranking recovery expectations'],
      entitySignals: [
        { name: 'SpamBrain', type: 'service', relationship: 'Represents Google automated spam-prevention systems that are periodically improved to detect new abuse types.' },
        { name: 'Spam update', type: 'concept', relationship: 'Names a notable improvement to automated spam detection that can change visibility outcomes.' },
        { name: 'Google Search spam policies', type: 'concept', relationship: 'Provides the compliance reference for investigation and remediation after traffic changes.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '此頁以可觀測的流量變化、政策審核、時間性與無法恢復舊有 link-spam benefit 的限制，提供以證據處理更新後搜尋表現的 response 多維樣本。', reviewerConfidence: 5,
    },
  },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database
  .select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil })
  .from(publicIntelligenceSources)
  .where(and(
    eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'),
    eq(publicIntelligenceSources.reviewStatus, 'approved'),
    eq(publicIntelligenceSources.allowedUse, 'training_candidate'),
    eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'),
    eq(publicIntelligenceSources.termsStatus, 'allows_training'),
    eq(publicIntelligenceSources.copyrightRisk, 'low'),
    eq(publicIntelligenceSources.piiStatus, 'none_detected'),
    isNull(publicIntelligenceSources.removedAt),
  ))
  .limit(1)

if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const annotation of annotations) {
  const [structural] = await database
    .select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus })
    .from(publicIntelligenceArtifacts)
    .where(and(
      eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId),
      eq(publicIntelligenceArtifacts.sourceId, source.id),
      eq(publicIntelligenceArtifacts.artifactType, 'structural_features'),
      eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
      isNull(publicIntelligenceArtifacts.removedAt),
    ))
    .limit(1)

  if (!structural?.sourceSpanHash) throw new Error(`batch_39_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_39_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') {
    await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  }

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database
    .select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus })
    .from(publicIntelligenceArtifacts)
    .where(and(
      eq(publicIntelligenceArtifacts.sourceId, source.id),
      eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
      eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl),
      isNull(publicIntelligenceArtifacts.removedAt),
    ))
    .limit(1)

  const human = existing || await createOwnerPublicArtifact({
    ownerUserId: source.ownerUserId,
    sourceId: source.id,
    sourceUrl: annotation.sourceUrl,
    canonicalUrl: annotation.sourceUrl,
    artifactType: 'human_annotation',
    artifactText: annotation.artifactText,
    sourceLocator: annotation.sourceLocator,
    sourceSpanHash: structural.sourceSpanHash,
    fieldData: labels,
    language: 'en',
    extractionMethod: 'human_annotation',
    requestedUse: 'training_candidate',
    retentionUntil: source.retentionUntil,
  })

  if (human.qualityStatus !== 'passed') {
    await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  }
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}
