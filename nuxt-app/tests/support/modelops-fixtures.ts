import { buildCitationSelectionDataset, normalizeTrustedObservation, reviewDataset, type OutcomeObservation } from '../../server/geo-outcome-model'
import { createMemoryGeoOutcomeRepository } from './geo-outcome-memory-repository'
import type { MemoryGeoOutcomeState } from '../../server/geo-outcome-model/types'
import { sha256Hex } from '../../server/geo-outcome-model/canonical'

const hash = (value: string) => sha256Hex(value)

function fixtureObservation(index: number, citationStatus: 'cited' | 'not_cited', ownerUserId: number): OutcomeObservation {
  const group = `scheduler-group-${index}`
  const website = `scheduler-site-${index}`
  const day = index + 1
  const date = new Date(Date.UTC(2025, 0, day)).toISOString()
  const page = `${group}-${citationStatus}`
  const input = { schemaVersion: 'geo-outcome-observation-v1', projectId: null, clientId: null, websiteIdentityHash: hash(website), queryIdentityHash: hash(group), normalizedQueryHash: hash(group), candidatePageIdentityHash: hash(page), canonicalPageHash: hash(`canonical-${website}`), contentHash: hash(`content-${page}`), evidenceSnapshotHash: hash(`evidence-${group}`), publicationReceiptFingerprint: hash(`receipt-${page}`), engine: index % 3 === 0 ? 'chatgpt' : index % 3 === 1 ? 'gemini' : 'perplexity', model: 'fixture-model', modelVersion: 'v1', interface: 'consumer_surface', locale: 'en', region: 'US', runIdentity: `scheduler-run-${group}`, runTimestamp: date, observationWindow: { start: date, end: new Date(Date.UTC(2025, 0, day, 1)).toISOString() }, observableStatus: 'observable', retrievalStatus: 'retrieved', citationStatus, citationPosition: citationStatus === 'cited' ? 1 : null, mentionStatus: citationStatus === 'cited' ? 'mentioned' : 'not_mentioned', recommendationStatus: 'unknown', labelBasis: 'manual_verified_primary', verificationStatus: 'verified', evidenceLocatorHashes: [hash(`locator-${group}`)], appliedRuleHashes: [], contentFeatureVector: { contentType: 'article', locale: 'en', pageAgeBucket: '8_30d', contentLengthBucket: citationStatus === 'cited' ? 'l' : 's', headingHierarchy: citationStatus === 'cited' ? 'structured' : 'flat', directAnswerPresence: citationStatus === 'cited' ? 'present' : 'absent', faqStructure: 'absent', structuredDataPresence: citationStatus === 'cited' ? 'present' : 'absent', citationMarkerCount: citationStatus === 'cited' ? 3 : 0, approvedAuthoritySourceCount: citationStatus === 'cited' ? 2 : 0, evidenceUtilizationRatio: citationStatus === 'cited' ? .8 : .1, entityCoverage: citationStatus === 'cited' ? .8 : .1, selectedAutoGeoRuleHashes: [], appliedAutoGeoRuleHashes: [], canonicalFlag: 'valid', indexabilityFlag: 'indexable', internalLinkDepthBucket: '1', contentFreshnessBucket: 'fresh', queryPageLexicalOverlap: citationStatus === 'cited' ? .8 : .1, topicClusterEqual: 'yes', verifiedPublicationAgeDays: 10, priorObservationCount: 1 } }
  return normalizeTrustedObservation(input, ownerUserId)
}

export async function trustedState(ownerUserId = 42): Promise<MemoryGeoOutcomeState> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error('trustedState requires a positive synthetic owner id.')
  const repository = createMemoryGeoOutcomeRepository()
  const rows = Array.from({ length: 500 }, (_, index) => [fixtureObservation(index + 1, 'cited', ownerUserId), fixtureObservation(index + 1, 'not_cited', ownerUserId)]).flat()
  const built = buildCitationSelectionDataset(rows, ownerUserId)
  for (const row of rows) await repository.saveObservationTransactional(ownerUserId, row)
  await repository.saveDatasetTransactional(ownerUserId, built.manifest, built.members)
  await reviewDataset(ownerUserId, built.manifest.manifestId, 'approve', ownerUserId, 'Owner approved scheduler fixture dataset.', repository, { knowledgeMode: 'declared_none_v1' })
  return repository.exportState()
}
