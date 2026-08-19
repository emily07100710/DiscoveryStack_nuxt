import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'

const duplicateAnnotations = [
  { artifactId: 1050001, sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link?hl=en', retainedArtifactId: 90004 },
  { artifactId: 1050002, sourceUrl: 'https://developers.google.com/search/docs/appearance/snippet?hl=en', retainedArtifactId: 90002 },
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'),
  eq(publicIntelligenceSources.reviewStatus, 'approved'),
  isNull(publicIntelligenceSources.removedAt),
)).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const duplicate of duplicateAnnotations) {
  const [artifact] = await database.select({ id: publicIntelligenceArtifacts.id, sourceUrl: publicIntelligenceArtifacts.sourceUrl, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).where(and(
    eq(publicIntelligenceArtifacts.id, duplicate.artifactId),
    eq(publicIntelligenceArtifacts.sourceId, source.id),
    eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
    eq(publicIntelligenceArtifacts.sourceUrl, duplicate.sourceUrl),
    isNull(publicIntelligenceArtifacts.removedAt),
  )).limit(1)
  if (!artifact) throw new Error(`batch_19_duplicate_annotation_not_found:${duplicate.artifactId}`)
  if (artifact.qualityStatus !== 'rejected') await reviewOwnerPublicArtifact({
    ownerUserId: source.ownerUserId,
    artifactId: artifact.id,
    qualityStatus: 'rejected',
    qualityNote: `Governance remediation: duplicate human annotation for the same source URL. Retain earlier approved artifact ${duplicate.retainedArtifactId}; reject this later duplicate so it cannot enter a training manifest.`,
  })
  console.log(JSON.stringify({ sourceUrl: duplicate.sourceUrl, retainedArtifactId: duplicate.retainedArtifactId, rejectedDuplicateArtifactId: artifact.id, status: 'rejected' }))
}
