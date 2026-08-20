import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../server/database/index.ts'
import { publicIntelligenceArtifacts, publicIntelligenceDatasetBuilds, publicIntelligenceSources } from '../server/database/schema.ts'
import { approveOwnerPublicDatasetBuild, createOwnerPublicDatasetBuild, getOwnerPublicManifestCandidateReadiness } from '../server/public-intelligence/repository.ts'
import { SEO_GEO_LABEL_TAXONOMY_VERSION } from '../server/public-intelligence/seoGeoTaxonomy.ts'
import { TRAINING_FEATURE_CONTRACT_VERSION, TRAINING_SPLIT_VERSION } from '../server/public-intelligence/training.ts'

const ownerUserId = 1
const datasetName = 'DiscoveryStack Google Search Central SEO/GEO Multitask Training Dataset'
const datasetVersion = 'gsc-ccby4-2026-08-20-101-v1'
const database = await getDatabase()

const readiness = await getOwnerPublicManifestCandidateReadiness(ownerUserId)
const requiredStages = ['discovery', 'understanding', 'response', 'progression', 'conversion']
if (readiness.approvedHumanAnnotations !== 101) throw new Error(`manifest_readiness_expected_101_found_${readiness.approvedHumanAnnotations}`)
for (const stage of requiredStages) {
  if ((readiness.stageCounts[stage] || 0) < 10) throw new Error(`manifest_stage_minimum_not_met:${stage}:${readiness.stageCounts[stage] || 0}`)
}

const artifactRows = await database.select({ id: publicIntelligenceArtifacts.id })
  .from(publicIntelligenceArtifacts)
  .innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id))
  .where(and(
    eq(publicIntelligenceSources.ownerUserId, ownerUserId),
    eq(publicIntelligenceSources.reviewStatus, 'approved'),
    eq(publicIntelligenceSources.allowedUse, 'training_candidate'),
    eq(publicIntelligenceSources.piiStatus, 'none_detected'),
    isNull(publicIntelligenceSources.removedAt),
    eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
    eq(publicIntelligenceArtifacts.extractionMethod, 'human_annotation'),
    eq(publicIntelligenceArtifacts.useSnapshot, 'training_candidate'),
    eq(publicIntelligenceArtifacts.qualityStatus, 'passed'),
    eq(publicIntelligenceArtifacts.piiStatus, 'none_detected'),
    isNull(publicIntelligenceArtifacts.removedAt),
  ))

if (artifactRows.length !== 101) throw new Error(`manifest_member_query_expected_101_found_${artifactRows.length}`)

const [existing] = await database.select({ id: publicIntelligenceDatasetBuilds.id, status: publicIntelligenceDatasetBuilds.status })
  .from(publicIntelligenceDatasetBuilds)
  .where(and(
    eq(publicIntelligenceDatasetBuilds.ownerUserId, ownerUserId),
    eq(publicIntelligenceDatasetBuilds.datasetName, datasetName),
    eq(publicIntelligenceDatasetBuilds.datasetVersion, datasetVersion),
  ))
  .limit(1)

if (existing) throw new Error(`manifest_version_already_exists:${existing.id}:${existing.status}`)

const created = await createOwnerPublicDatasetBuild({
  ownerUserId,
  datasetName,
  datasetVersion,
  intendedUse: 'training',
  featureContractVersion: TRAINING_FEATURE_CONTRACT_VERSION,
  labelTaxonomyVersion: SEO_GEO_LABEL_TAXONOMY_VERSION,
  splitVersion: TRAINING_SPLIT_VERSION,
  artifactIds: artifactRows.map(row => row.id),
  reviewNote: 'Owner-reviewed immutable manifest: 101 unique Google Search Central CC BY 4.0 human annotations; PII clear, quality passed, canonical-source deduplicated, and each SEO/GEO journey stage meets the minimum coverage gate.',
})

const approved = await approveOwnerPublicDatasetBuild({
  ownerUserId,
  datasetBuildId: created.datasetBuildId,
  reviewNote: 'Owner approval recorded after independent readiness verification: 101 unique, PII-cleared, quality-passed human annotations with all five journey stages at or above 10 samples.',
})

console.log(JSON.stringify({ readiness, created, approved }, null, 2))
