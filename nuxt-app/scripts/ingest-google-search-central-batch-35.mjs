import { getDatabase } from '../server/database/index.ts'
import { and, eq, isNull } from 'drizzle-orm'
import { publicIntelligenceSources } from '../server/database/schema.ts'
import { ingestApprovedPublicDocument } from '../server/public-intelligence/ingestion-repository.ts'

const requestedUrls = [
  'https://developers.google.com/search/docs/fundamentals/how-search-works',
  'https://developers.google.com/search/docs/appearance',
  'https://developers.google.com/search/docs/essentials',
  'https://developers.google.com/search/docs/monitor-debug/search-console-start',
  'https://developers.google.com/search/docs/monitor-debug/debugging-search-traffic-drops',
]

const database = getDatabase()
if (!database) throw new Error('database_unavailable')

const [source] = await database.select({ id: publicIntelligenceSources.id, ownerUserId: publicIntelligenceSources.ownerUserId }).from(publicIntelligenceSources).where(and(
  eq(publicIntelligenceSources.sourceName, 'Google Search Central Documentation（CC BY 4.0）'),
  eq(publicIntelligenceSources.reviewStatus, 'approved'),
  eq(publicIntelligenceSources.allowedUse, 'training_candidate'),
  eq(publicIntelligenceSources.robotsStatus, 'reviewed_allow'),
  eq(publicIntelligenceSources.termsStatus, 'allows_training'),
  eq(publicIntelligenceSources.copyrightRisk, 'low'),
  eq(publicIntelligenceSources.piiStatus, 'none_detected'),
  isNull(publicIntelligenceSources.removedAt),
)).limit(1)

if (!source) throw new Error('approved_google_search_central_source_not_found')

for (const requestedUrl of requestedUrls) {
  try {
    const result = await ingestApprovedPublicDocument({ ownerUserId: source.ownerUserId, sourceId: source.id, requestedUrl })
    console.log(JSON.stringify({ requestedUrl, status: result.status, jobId: result.jobId, artifactId: result.primaryArtifactId }))
  } catch (error) {
    const statusMessage = error && typeof error === 'object' && 'statusMessage' in error ? String(error.statusMessage) : 'request_failed'
    console.log(JSON.stringify({ requestedUrl, status: 'failed', statusMessage }))
  }
}
