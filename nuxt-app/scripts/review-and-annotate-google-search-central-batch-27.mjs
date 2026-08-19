import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1380001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/javascript/lazy-loading?hl=en',
    sourceLocator: 'human-review:batch-27:javascript-lazy-loading',
    artifactText: 'Treat JavaScript lazy loading as a conversion-path discoverability constraint. Load relevant content when it becomes visible without requiring a user scroll or click, because Google Search processing is non-interactive. For infinite scroll, retain persistent unique URLs, stable page content, and sequential anchor links so crawlers and users can access paginated loading states. Verify rendered HTML in URL Inspection and preserve the boundary that rendering compliance does not guarantee indexing or a displayed result.',
    qualityNote: '人工閱讀 JavaScript lazy loading 文件：摘要保留 non-interactive rendering、viewport loading、pagination fallback、unique URLs、sequential links 與 rendered HTML verification；不含 PII，且不將可爬取性表述為收錄保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['conversion', 'progression', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['JavaScript lazy loading', 'rendered HTML', 'infinite scroll pagination', 'crawlable navigation', 'URL Inspection'],
      entitySignals: [
        { name: 'Google Search', type: 'service', relationship: 'Processes pages without interactive scroll or click events when evaluating whether content can be discovered.' },
        { name: 'URL Inspection', type: 'service', relationship: 'Supports inspection of rendered HTML when verifying lazy-loaded content exposure.' },
        { name: 'Infinite scroll', type: 'concept', relationship: 'Needs persistent paginated URLs and sequential links to preserve crawler and user access.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'information_overload'], actionPriority: 'high',
      annotationRationale: '本頁將 JavaScript rendering 與 non-interactive crawling 邊界映射到 conversion-path content discovery，並提供可驗證的 lazy-load、pagination 與 inspection 行動，適合訓練技術性轉換阻礙診斷。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1380002,
    sourceUrl: 'https://developers.google.com/search/docs/specialty/international/localized-versions?hl=en',
    sourceLocator: 'human-review:batch-27:localized-versions',
    artifactText: 'Use localized-version annotations to clarify the alternate audience path rather than to promise language targeting. Supply hreflang alternates through one equivalent method—HTML, HTTP headers, or sitemap—with fully qualified URLs, self-references, and mutual links across version sets. Use x-default for an unmatched language or locale. Keep the boundary that Google uses its own algorithms to detect page language rather than hreflang or the HTML lang attribute alone, then verify whether international alternatives remain discoverable and internally consistent.',
    qualityNote: '人工閱讀 localized versions 文件：摘要保留 hreflang 的三種等效實作、fully-qualified／self／mutual alternates、x-default 與 language-detection 邊界；不含 PII，且不將 annotation 表述為語言或排名保證。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding',
      journeyStages: ['understanding', 'discovery', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'tool'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['hreflang', 'localized versions', 'international SEO', 'language detection', 'x-default'],
      entitySignals: [
        { name: 'hreflang', type: 'concept', relationship: 'Annotates alternate localized versions through equivalent HTML, HTTP header, or sitemap methods.' },
        { name: 'Google language detection', type: 'service', relationship: 'Uses algorithms to determine page language independently from hreflang and lang attributes.' },
        { name: 'x-default', type: 'concept', relationship: 'Provides a fallback page for visitors whose language or locale does not match an alternate.' },
      ],
      geoSignals: ['global', 'country', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'internal_routing', 'language_signal'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high',
      annotationRationale: '本頁將多語系 alternate URL 結構、locale fallback 及自動語言偵測的限制轉化為可檢驗的 technical understanding，適合訓練國際化發現與修正建議，而不虛構 targeting 保證。', reviewerConfidence: 5,
    },
  },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId, retentionUntil: publicIntelligenceSources.retentionUntil }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt),
)).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const annotation of annotations) {
  const [structural] = await database.select({ id: publicIntelligenceArtifacts.id, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.id, annotation.structuralArtifactId), eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'structural_features'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  if (!structural?.sourceSpanHash) throw new Error(`batch_27_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_27_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}
