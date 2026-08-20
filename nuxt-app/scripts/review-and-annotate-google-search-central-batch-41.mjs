import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { createOwnerPublicArtifact, reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'
import { seoGeoMultilabelSchema } from '../server/public-intelligence/seoGeoTaxonomy.ts'

const annotations = [
  {
    structuralArtifactId: 2190001,
    sourceUrl: 'https://developers.google.com/search/docs/appearance/structured-data/math-solvers',
    sourceLocator: 'human-review:batch-41:math-solver-structured-data',
    artifactText: 'Google Search can use MathSolver and LearningResource structured data on an accessible math-solver home page to help users find step-by-step mathematical explanations. Publishers should add the required SolveMathAction properties, use canonical URLs for identical copies, keep the initial solution and walkthrough accessible without a login or paywall, validate markup with Rich Results Test, check Google access with URL Inspection, avoid robots.txt or noindex blocks, request recrawl after deployment and submit a sitemap for later changes. The feature has content-quality policies and rich-result appearance is not guaranteed.',
    qualityNote: '人工閱讀 Math Solver structured data：摘要保留 MathSolver／LearningResource、SolveMathAction、rich-result eligibility、canonical URL、multilingual language signals、login/paywall access、Rich Results Test、URL Inspection、crawl/index requirements與品質政策；官方頁尾標示 CC BY 4.0，PII extractor v4 為 none_detected。',
    labels: {
      annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'discovery',
      journeyStages: ['discovery', 'understanding', 'conversion'], searchIntents: ['informational', 'commercial'], contentTypes: ['service', 'tool', 'editorial'], audienceRoles: ['researcher', 'practitioner', 'technical_evaluator', 'decision_maker'],
      topicClusters: ['MathSolver structured data', 'LearningResource markup', 'SolveMathAction', 'math solver rich results', 'canonical and multilingual access', 'structured data validation'],
      entitySignals: [
        { name: 'MathSolver', type: 'concept', relationship: 'Declares a math-solver capability and its step-by-step solution action for eligible Search discovery.' },
        { name: 'Rich Results Test', type: 'service', relationship: 'Validates MathSolver markup and surfaces critical structured-data errors before publishing.' },
        { name: 'URL Inspection tool', type: 'service', relationship: 'Checks whether Google can access the deployed math-solver page before requesting recrawl.' },
      ],
      geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'dated_or_current', 'source_links', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'indexable', 'structured_data', 'internal_routing', 'language_signal', 'performance_not_observed'], frictionSignals: ['information_overload', 'no_material_friction_observed'], actionPriority: 'high',
      annotationRationale: '此頁把教育型工具的搜尋發現、結構化標記、跨語言／canonical 部署、公開解題體驗與驗證流程連結成可操作準則，並保留 eligibility 不等於 rich-result 呈現保證的界線，適合作為 discovery 多維樣本。', reviewerConfidence: 5,
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

  if (!structural?.sourceSpanHash) throw new Error(`batch_41_structural_artifact_not_found:${annotation.structuralArtifactId}`)
  if (structural.piiStatus !== 'none_detected') throw new Error(`batch_41_pii_not_clear:${annotation.structuralArtifactId}`)
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
