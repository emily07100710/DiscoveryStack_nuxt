import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 660001,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro?hl=en',
    artifactText: 'Use robots.txt to manage crawler traffic rather than to hide content from Google Search. A robots rule can control whether Googlebot fetches a web page, media file, or resource, but a disallowed URL may still be known or indexed if other signals point to it. Choose other protections, such as noindex, authentication, or removal controls, when the goal is to keep content out of Search. Verify the rule syntax and its target crawler, distinguish web crawling from media or resource crawling, and test a change before relying on it. Treat robots.txt as a technical access control with clear limitations, then inspect crawl and indexing outcomes instead of assuming a blocked fetch guarantees privacy or removal.',
    sourceLocator: 'human-review:batch-13:robots-intro',
    qualityNote: '人工閱讀官方文件：涵蓋 robots.txt 的 crawler traffic 控制、web/media/resource 影響、disallowed URL 仍可能被索引、noindex/password/removal alternatives、crawler-specific rules 與測試限制。摘要與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response', journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational'], contentTypes: ['editorial', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['robots.txt', 'crawl control', 'indexing limitations', 'noindex', 'crawler access', 'technical governance'], entitySignals: [{ name: 'robots.txt', type: 'concept', relationship: 'Controls crawler fetching but does not itself guarantee Search exclusion.' }, { name: 'Googlebot', type: 'service', relationship: 'Uses applicable robots rules before retrieving eligible website resources.' }, { name: 'noindex', type: 'concept', relationship: 'Provides a different mechanism when the objective is search exclusion rather than crawl traffic control.' }], geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high', annotationRationale: '本頁澄清 robots.txt 的可為與不可為，將錯誤的隱藏或去索引期待轉為可驗證的 crawler、noindex 與 inspection 回應路徑，適合訓練 response-stage 的技術風險診斷。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 660002,
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects?hl=en',
    artifactText: 'Use redirects to send users and Google Search from an old URL to the most appropriate canonical destination during a site move, URL consolidation, merger, or page retirement. Select a permanent HTTP redirect such as 301 or 308 when the change is durable, and use temporary redirects such as 302, 303, or 307 only when the destination should not replace the original permanently. Prefer server-side redirects where possible, keep chains short, map old URLs to relevant replacements, and avoid sending many removed pages to an unrelated home page. Meta refresh and JavaScript redirects may be interpreted, but they are less reliable because rendering and processing can vary. Monitor the migration, validate destinations, and keep redirect decisions aligned with canonical URLs and user intent.',
    sourceLocator: 'human-review:batch-13:redirects',
    qualityNote: '人工閱讀官方文件：涵蓋 site move、canonical destination、301/308、302/303/307、server/meta refresh/JavaScript redirects、redirect chain、old-to-relevant-new mapping、rendering limitation 與 implementation hierarchy。摘要與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'progression', journeyStages: ['response', 'progression'], searchIntents: ['informational', 'navigational'], contentTypes: ['editorial', 'service', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['301 redirects', 'site migration', 'canonical URL', 'redirect chains', 'URL consolidation', 'user intent'], entitySignals: [{ name: 'HTTP 301', type: 'concept', relationship: 'Signals a durable move from an old URL to a canonical destination.' }, { name: 'canonical URL', type: 'concept', relationship: 'Should align with redirect mapping and the intended final destination.' }, { name: 'Google Search', type: 'service', relationship: 'Processes redirect signals while crawl and rendering methods have different reliability.' }], geoSignals: ['global', 'country'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_next_step', 'missing_trust_signal'], actionPriority: 'high', annotationRationale: '本頁將 URL migration 的永久性、HTTP implementation、canonical alignment、chain avoidance 與 user-relevant destination 串成可驗證流程，適合訓練 progression-stage 的技術 SEO 執行與風險優先度。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 660003,
    sourceUrl: 'https://developers.google.com/crawling/docs/crawl-budget?hl=en',
    artifactText: 'Optimize crawl budget for a large or frequently changing site by separating crawl capacity from crawl demand and protecting host health. Review the URLs Google can discover, remove duplicate or low-value inventory, maintain accurate sitemaps and internal links, use sensible status codes for removed or unchanged pages, and avoid unnecessary redirect chains or soft 404 responses. Improve server response efficiency so Googlebot can fetch important pages without overloading the host, then use Search Console reporting, crawl statistics, and server evidence to diagnose whether a capacity, demand, duplication, or response problem exists. Crawl estimates are rough guides, not guarantees, so prioritize the pages that matter most to users and business outcomes before assuming more crawling is always beneficial.',
    sourceLocator: 'human-review:batch-13:crawl-budget',
    qualityNote: '人工閱讀官方文件：涵蓋 large/fast-changing site 的 crawl capacity/demand、host health、inventory/duplicates、sitemap、HTTP 404/410/304、soft 404、redirect chain、server efficiency、Search Console diagnosis 與 rough-estimate limitation。摘要與 reviewed source span 一致，未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'response', journeyStages: ['understanding', 'response', 'progression'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'service', 'tool'], audienceRoles: ['practitioner', 'technical_evaluator', 'decision_maker'], topicClusters: ['crawl budget', 'crawl capacity', 'crawl demand', 'host health', 'duplicate URLs', 'server response'], entitySignals: [{ name: 'Googlebot', type: 'service', relationship: 'Fetches site content subject to crawl capacity, demand, and host health.' }, { name: 'Search Console', type: 'service', relationship: 'Provides evidence for crawl statistics and indexing-related diagnosis.' }, { name: 'sitemap', type: 'concept', relationship: 'Helps communicate priority URL inventory when maintained accurately.' }], geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links'], technicalSeoSignals: ['canonical_present', 'indexable', 'internal_routing', 'performance_not_observed'], frictionSignals: ['information_overload', 'missing_next_step'], actionPriority: 'high', annotationRationale: '本頁將網站規模、URL inventory、duplicate reduction、HTTP semantics、host performance 與 evidence-based diagnosis 整合，適合訓練 response-stage 的 technical SEO prioritization，而不把 crawl volume誤作保證。', reviewerConfidence: 5,
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

  if (!structural?.sourceSpanHash) throw new Error(`batch_13_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_13_pii_not_clear:${annotation.structuralArtifactId}`)
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
      eq(publicIntelligenceArtifacts.sourceSpanHash, structural.sourceSpanHash),
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
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: 'passed' }))
}
