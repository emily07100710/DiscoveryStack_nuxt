import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceSources } from '../server/database/schema.ts'
import { ingestApprovedPublicDocument } from '../server/public-intelligence/ingestion-repository.ts'

const candidateUrls = [
  'https://developers.google.com/search/docs/appearance/structured-data/local-business?hl=en',
  'https://developers.google.com/search/docs/appearance/structured-data/organization?hl=en',
  'https://developers.google.com/search/docs/appearance/structured-data/review-snippet?hl=en',
  'https://developers.google.com/search/docs/appearance/structured-data/return-policy?hl=en',
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')
const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.allowedUse, 'training_candidate'), eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'), eq(publicIntelligenceSources.termsStatus, 'allows_training'), eq(publicIntelligenceSources.copyrightRisk, 'low'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt),
)).limit(1)
if (!source) throw new Error('approved_google_search_central_source_not_found')
for (const requestedUrl of candidateUrls) {
  try {
    const result = await ingestApprovedPublicDocument({ ownerUserId: source.ownerUserId, sourceId: source.id, requestedUrl })
    console.log(JSON.stringify({ requestedUrl, status: result.status, jobId: result.jobId, artifactId: result.primaryArtifactId }))
  } catch (error) {
    const statusMessage = error && typeof error === 'object' && 'statusMessage' in error ? String(error.statusMessage) : 'request_failed'
    console.log(JSON.stringify({ requestedUrl, status: 'failed', statusMessage }))
  }
  await new Promise(resolve => setTimeout(resolve, 1250))
}
