import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 1680001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/course?hl=en',
    sourceLocator: 'human-review:batch-32:course-structured-data',
    artifactText: 'Course structured data helps eligible education providers describe a course name, description, provider, image, offers, and course instances for Google Search. Mark up the visible course information with the appropriate Course and CourseInstance properties, then validate the implementation and monitor it through Search Console. Eligibility for a course-related search experience does not guarantee crawling, indexing, ranking, or a particular displayed result, so keep the public course page accurate and useful for people independently of markup.',
    qualityNote: '人工閱讀 Course structured data：摘要保留 provider eligibility、Course/CourseInstance、visible-page alignment、validation/monitoring 與 rich-result non-guarantee；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'conversion',
      journeyStages: ['conversion', 'discovery', 'response'], searchIntents: ['informational', 'commercial'], contentTypes: ['service', 'product', 'editorial'], audienceRoles: ['buyer', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['course structured data', 'education provider', 'CourseInstance', 'rich result eligibility', 'Search Console validation'],
      entitySignals: [
        { name: 'Course', type: 'product', relationship: 'Represents a public educational offering whose visible details may be described with structured data.' },
        { name: 'CourseInstance', type: 'concept', relationship: 'Describes a particular course offering, schedule, location, or delivery mode within course markup.' },
        { name: 'Google Search Console', type: 'service', relationship: 'Provides validation and monitoring context after structured data is implemented.' },
      ],
      geoSignals: ['global', 'country', 'not_applicable'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'missing_next_step', 'information_overload'], actionPriority: 'medium',
      annotationRationale: '本頁將可驗證的 course markup、公開可見內容與 eligibility 非保證邊界連結至教育服務的 discovery 到 conversion journey，適合作為技術實作與內容一致性訓練證據。', reviewerConfidence: 5,
    },
  },
  {
    structuralArtifactId: 1680002,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/image-license-metadata?hl=en',
    sourceLocator: 'human-review:batch-32:image-license-metadata',
    artifactText: 'Image metadata can communicate who created an image, how people may use it, and where licensing information is available. Use a license URL or IPTC Web Statement of Rights to describe governing rights, and use acquireLicensePage or a Licensor URL to point users toward licensing information. The Licensable badge requires the relevant license or rights statement data, but markup and metadata express eligibility rather than a guarantee of image discovery or display. Keep rights information accurate, accessible, and consistent with the public image page.',
    qualityNote: '人工閱讀 Image license metadata：摘要保留 creator/credit、license、acquireLicensePage、IPTC rights statement、Licensor URL、Licensable badge eligibility 與 non-guarantee；未含 PII。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['editorial', 'product', 'service'], audienceRoles: ['researcher', 'buyer', 'practitioner', 'media_or_partner'],
      topicClusters: ['image license metadata', 'creator credit', 'licensable badge', 'rights statement', 'image discovery'],
      entitySignals: [
        { name: 'Image metadata', type: 'concept', relationship: 'Communicates image creator, rights, and licensing context for a public image page.' },
        { name: 'Licensable badge', type: 'concept', relationship: 'Is an eligible Google Images treatment when the required license or rights statement data is supplied.' },
        { name: 'IPTC Web Statement of Rights', type: 'concept', relationship: 'Provides a URL-based rights statement that can describe governing image license information.' },
      ],
      geoSignals: ['global', 'not_applicable'], citationReadiness: ['first_party_expertise', 'source_links', 'structured_data', 'insufficient_evidence'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'performance_not_observed'], frictionSignals: ['missing_trust_signal', 'missing_next_step', 'unclear_value'], actionPriority: 'medium',
      annotationRationale: '本頁提供影像來源、權利聲明與取得授權路徑的可引用 metadata evidence，同時保留 badge 與 discovery 非保證界線，適合作為 discovery-stage 的 SEO/GEO 信號。', reviewerConfidence: 5,
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
  if (!structural?.sourceSpanHash) throw new Error(`batch_32_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_32_pii_not_clear:${annotation.structuralArtifactId}`)
  if (structural.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: structural.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })

  const labels = seoGeoMultilabelSchema.parse(annotation.labels)
  const [existing] = await database.select({ id: publicIntelligenceArtifacts.id, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), eq(publicIntelligenceArtifacts.sourceUrl, annotation.sourceUrl), isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  const human = existing || await createOwnerPublicArtifact({ ownerUserId: source.ownerUserId, sourceId: source.id, sourceUrl: annotation.sourceUrl, canonicalUrl: annotation.sourceUrl, artifactType: 'human_annotation', artifactText: annotation.artifactText, sourceLocator: annotation.sourceLocator, sourceSpanHash: structural.sourceSpanHash, fieldData: labels, language: 'en', extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: source.retentionUntil })
  if (human.qualityStatus !== 'passed') await reviewOwnerPublicArtifact({ ownerUserId: source.ownerUserId, artifactId: human.id, qualityStatus: 'passed', qualityNote: annotation.qualityNote })
  console.log(JSON.stringify({ sourceUrl: annotation.sourceUrl, structuralArtifactId: structural.id, humanAnnotationId: human.id, primaryJourneyStage: labels.primaryJourneyStage, status: existing ? 'retained_existing' : 'passed' }))
}
