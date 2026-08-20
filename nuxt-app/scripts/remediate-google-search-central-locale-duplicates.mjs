import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceSources } from '../server/database/schema.ts'
import { reviewOwnerPublicArtifact } from '../server/public-intelligence/repository.ts'

const laterLocaleDuplicates = [
  {
    artifactId: 1860001,
    retainedArtifactId: 270001,
    canonicalPath: '/search/docs/fundamentals/how-search-works',
  },
  {
    artifactId: 1860003,
    retainedArtifactId: 270005,
    canonicalPath: '/search/docs/essentials',
  },
  {
    artifactId: 1860004,
    retainedArtifactId: 390002,
    canonicalPath: '/search/docs/monitor-debug/search-console-start',
  },
  {
    artifactId: 1860005,
    retainedArtifactId: 510001,
    canonicalPath: '/search/docs/monitor-debug/debugging-search-traffic-drops',
  },
]

const database = getDatabase()
const candidates = await database.select({
  id: publicIntelligenceArtifacts.id,
  sourceUrl: publicIntelligenceArtifacts.sourceUrl,
  qualityStatus: publicIntelligenceArtifacts.qualityStatus,
  ownerUserId: publicIntelligenceSources.ownerUserId,
}).from(publicIntelligenceArtifacts)
  .innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id))
  .where(and(
    inArray(publicIntelligenceArtifacts.id, laterLocaleDuplicates.map(item => item.artifactId)),
    eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
    eq(publicIntelligenceArtifacts.piiStatus, 'none_detected'),
    eq(publicIntelligenceArtifacts.useSnapshot, 'training_candidate'),
    isNull(publicIntelligenceArtifacts.removedAt),
    isNull(publicIntelligenceSources.removedAt),
  ))

if (candidates.length !== laterLocaleDuplicates.length) throw new Error(`locale_duplicate_remediation_precondition_failed:${candidates.length}`)

for (const duplicate of laterLocaleDuplicates) {
  const candidate = candidates.find(item => item.id === duplicate.artifactId)
  if (!candidate) throw new Error(`locale_duplicate_annotation_not_found:${duplicate.artifactId}`)
  if (candidate.qualityStatus !== 'passed') throw new Error(`locale_duplicate_annotation_not_passed:${duplicate.artifactId}`)

  await reviewOwnerPublicArtifact({
    ownerUserId: candidate.ownerUserId,
    artifactId: candidate.id,
    qualityStatus: 'rejected',
    qualityNote: `Rejected as a later locale rendering of Google Search Central canonical path ${duplicate.canonicalPath}; retained earlier approved human annotation ${duplicate.retainedArtifactId}. No data was deleted.`,
  })

  console.log(JSON.stringify({
    rejectedArtifactId: candidate.id,
    rejectedSourceUrl: candidate.sourceUrl,
    retainedArtifactId: duplicate.retainedArtifactId,
    canonicalPath: duplicate.canonicalPath,
    outcome: 'rejected_as_locale_duplicate',
  }))
}
