import { sql } from 'drizzle-orm'
import { boolean, decimal, index, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

/** OAuth identities are private and are used only for owner-gated administration. */
export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  openId: varchar('openId', { length: 64 }).notNull().unique(),
  name: text('name'),
  email: varchar('email', { length: 320 }),
  loginMethod: varchar('loginMethod', { length: 64 }),
  role: mysqlEnum('role', ['user', 'admin']).default('user').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp('lastSignedIn').defaultNow().notNull(),
})

/** Owner-only provider credentials. Secret values are AES-GCM ciphertext and are never returned to the browser. */
export const providerCredentials = mysqlTable('providerCredentials', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  firecrawlApiKeyCiphertext: text('firecrawlApiKeyCiphertext'),
  huggingFaceApiTokenCiphertext: text('huggingFaceApiTokenCiphertext'),
  huggingFaceNamespace: varchar('huggingFaceNamespace', { length: 200 }),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex('provider_credentials_owner_unique').on(table.ownerUserId)])


/** Lead records are private operational data. No audit content, raw request IP, or client-source HTML is stored here. */
export const leads = mysqlTable('leads', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  company: varchar('company', { length: 160 }).notNull(),
  website: varchar('website', { length: 2048 }),
  packageInterest: mysqlEnum('packageInterest', ['discover', 'clarify', 'grow', 'unsure']).notNull(),
  language: mysqlEnum('language', ['en', 'zh-hant']).notNull(),
  message: text('message'),
  privacyConsent: boolean('privacyConsent').notNull(),
  recontactConsent: boolean('recontactConsent').default(false).notNull(),
  /** Optional, purpose-specific permission for de-identified site signals and review corrections only. */
  modelImprovementConsent: boolean('modelImprovementConsent').default(false).notNull(),
  modelImprovementConsentVersion: varchar('modelImprovementConsentVersion', { length: 80 }),
  modelImprovementConsentAt: timestamp('modelImprovementConsentAt'),
  modelImprovementConsentRevokedAt: timestamp('modelImprovementConsentRevokedAt'),
  status: mysqlEnum('status', ['new', 'contacted', 'qualified', 'closed']).default('new').notNull(),
  dedupeKey: varchar('dedupeKey', { length: 64 }).notNull(),
  requestFingerprint: varchar('requestFingerprint', { length: 64 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  index('leads_dedupe_key_idx').on(table.dedupeKey),
  index('leads_created_at_idx').on(table.createdAt),
])

/** A tenant and consent boundary for one explicitly authorised public-site review. */
export const auditWorkspaces = mysqlTable('auditWorkspaces', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  displayName: varchar('displayName', { length: 160 }).notNull(),
  targetDomain: varchar('targetDomain', { length: 253 }).notNull(),
  language: mysqlEnum('language', ['en', 'zh-hant']).notNull(),
  publicAuditAuthorization: boolean('publicAuditAuthorization').default(false).notNull(),
  trainingConsent: boolean('trainingConsent').default(false).notNull(),
  consentRevokedAt: timestamp('consentRevokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
  deletedAt: timestamp('deletedAt'),
}, table => [index('audit_workspaces_owner_idx').on(table.ownerUserId)])

/** A bounded audit request. Current Nuxt release records manual public signals only; external crawling is intentionally not enabled here. */
export const auditRuns = mysqlTable('auditRuns', {
  id: int('id').autoincrement().primaryKey(),
  workspaceId: int('workspaceId').notNull().references(() => auditWorkspaces.id),
  provider: mysqlEnum('provider', ['manual', 'firecrawl']).default('manual').notNull(),
  status: mysqlEnum('status', ['queued', 'processing', 'completed', 'failed', 'cancelled', 'blocked']).default('queued').notNull(),
  requestedUrl: varchar('requestedUrl', { length: 2048 }).notNull(),
  scopePolicy: json('scopePolicy').notNull(),
  analyzerVersion: varchar('analyzerVersion', { length: 80 }).notNull(),
  errorCode: varchar('errorCode', { length: 80 }),
  errorDetail: text('errorDetail'),
  requestedAt: timestamp('requestedAt').defaultNow().notNull(),
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
}, table => [index('audit_runs_workspace_idx').on(table.workspaceId)])

/** Page metadata only. Raw HTML, customer analytics and unauthorised source content never enter this table. */
export const auditPages = mysqlTable('auditPages', {
  id: int('id').autoincrement().primaryKey(),
  auditRunId: int('auditRunId').notNull().references(() => auditRuns.id),
  sourceUrl: varchar('sourceUrl', { length: 2048 }).notNull(),
  finalUrl: varchar('finalUrl', { length: 2048 }),
  canonicalUrl: varchar('canonicalUrl', { length: 2048 }),
  pageType: mysqlEnum('pageType', ['home', 'service', 'faq', 'contact', 'booking', 'work', 'other']).default('other').notNull(),
  httpStatus: int('httpStatus'),
  title: varchar('title', { length: 500 }),
  pageLanguage: varchar('pageLanguage', { length: 24 }),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  snapshotStorageKey: varchar('snapshotStorageKey', { length: 512 }),
  snapshotByteLength: int('snapshotByteLength'),
  fetchedAt: timestamp('fetchedAt').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [index('audit_pages_run_idx').on(table.auditRunId)])

/** A normalised, independently reviewable public structural signal. */
export const auditObservations = mysqlTable('auditObservations', {
  id: int('id').autoincrement().primaryKey(),
  auditRunId: int('auditRunId').notNull().references(() => auditRuns.id),
  auditPageId: int('auditPageId').notNull().references(() => auditPages.id),
  observationKey: varchar('observationKey', { length: 120 }).notNull(),
  valueText: text('valueText'),
  valueNumber: decimal('valueNumber', { precision: 10, scale: 2 }),
  evidenceQuote: text('evidenceQuote'),
  evidenceSelector: varchar('evidenceSelector', { length: 512 }),
  confidence: int('confidence').notNull(),
  extractionVersion: varchar('extractionVersion', { length: 80 }).notNull(),
  observedAt: timestamp('observedAt').defaultNow().notNull(),
}, table => [index('audit_observations_run_idx').on(table.auditRunId)])

/** Claim provenance deliberately separates observed facts from rule inferences and human confirmation. */
export const auditEvidenceLedger = mysqlTable('auditEvidenceLedger', {
  id: int('id').autoincrement().primaryKey(),
  auditRunId: int('auditRunId').notNull().references(() => auditRuns.id),
  stage: mysqlEnum('stage', ['acquisition', 'normalisation', 'classification', 'human_review']).notNull(),
  claimKey: varchar('claimKey', { length: 120 }).notNull(),
  claimValue: text('claimValue').notNull(),
  provenance: mysqlEnum('provenance', ['observed', 'inferred', 'estimated', 'human_confirmed']).notNull(),
  observationIds: json('observationIds').notNull(),
  confidence: int('confidence').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [index('audit_evidence_run_idx').on(table.auditRunId)])

/** Explainable baseline output. Conversion is always marked insufficient without authorised first-party evidence. */
export const frictionAssessments = mysqlTable('frictionAssessments', {
  id: int('id').autoincrement().primaryKey(),
  auditRunId: int('auditRunId').notNull().references(() => auditRuns.id),
  journeyStage: mysqlEnum('journeyStage', ['discovery', 'understanding', 'response', 'progression', 'conversion']).notNull(),
  priorityRank: int('priorityRank').notNull(),
  score: decimal('score', { precision: 6, scale: 2 }).notNull(),
  assessmentStatus: mysqlEnum('assessmentStatus', ['supported', 'insufficient_evidence', 'needs_review']).notNull(),
  summary: text('summary').notNull(),
  evidenceLedgerIds: json('evidenceLedgerIds').notNull(),
  classifierVersion: varchar('classifierVersion', { length: 80 }).notNull(),
  requiresHumanReview: boolean('requiresHumanReview').default(true).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [index('friction_assessments_run_idx').on(table.auditRunId)])

/** A strategist review is the only source of supervised labels; automatic classifier output is never training truth. */
export const auditReviews = mysqlTable('auditReviews', {
  id: int('id').autoincrement().primaryKey(),
  auditRunId: int('auditRunId').notNull().references(() => auditRuns.id),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  decision: mysqlEnum('decision', ['confirmed', 'amended', 'rejected']).notNull(),
  correctedPrimaryStage: mysqlEnum('correctedPrimaryStage', ['discovery', 'understanding', 'response', 'progression', 'conversion']),
  reviewNote: text('reviewNote'),
  labelTaxonomyVersion: varchar('labelTaxonomyVersion', { length: 80 }).notNull(),
  labelContractVersion: varchar('labelContractVersion', { length: 80 }).notNull(),
  qualityCheckStatus: mysqlEnum('qualityCheckStatus', ['pending', 'passed', 'needs_revision', 'rejected']).default('pending').notNull(),
  qualityCheckNote: text('qualityCheckNote'),
  approvedForTraining: boolean('approvedForTraining').default(false).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [index('audit_reviews_run_idx').on(table.auditRunId)])

/** De-identified, versioned feature record. Revoked consent automatically takes the record out of any usable split. */
export const auditTrainingExamples = mysqlTable('auditTrainingExamples', {
  id: int('id').autoincrement().primaryKey(),
  workspaceId: int('workspaceId').notNull().references(() => auditWorkspaces.id),
  auditRunId: int('auditRunId').notNull().references(() => auditRuns.id),
  reviewId: int('reviewId').notNull().references(() => auditReviews.id),
  featureContractVersion: varchar('featureContractVersion', { length: 80 }).notNull(),
  labelTaxonomyVersion: varchar('labelTaxonomyVersion', { length: 80 }).notNull(),
  datasetVersion: varchar('datasetVersion', { length: 80 }).notNull(),
  splitVersion: varchar('splitVersion', { length: 80 }).notNull(),
  dataSplit: mysqlEnum('dataSplit', ['unassigned', 'train', 'validation', 'test', 'holdout']).default('unassigned').notNull(),
  labelStage: mysqlEnum('labelStage', ['discovery', 'understanding', 'response', 'progression', 'conversion']).notNull(),
  labelDecision: mysqlEnum('labelDecision', ['confirmed', 'amended']).notNull(),
  labelRationale: text('labelRationale').notNull(),
  featureVector: json('featureVector').notNull(),
  trainingConsent: boolean('trainingConsent').notNull(),
  consentRevokedAt: timestamp('consentRevokedAt'),
  datasetStatus: mysqlEnum('datasetStatus', ['candidate', 'ready_for_evaluation', 'excluded', 'revoked']).default('candidate').notNull(),
  qualityCheckStatus: mysqlEnum('qualityCheckStatus', ['pending', 'passed', 'needs_revision', 'rejected']).default('pending').notNull(),
  qualityCheckNote: text('qualityCheckNote'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('audit_training_examples_review_unique').on(table.reviewId),
  index('audit_training_examples_workspace_idx').on(table.workspaceId),
  index('audit_training_examples_dataset_idx').on(table.datasetStatus, table.trainingConsent),
])

/** Source-level provenance and policy record for publicly accessible resources. Public access alone never assigns a training use. */
export const publicIntelligenceSources = mysqlTable('publicIntelligenceSources', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  sourceFingerprint: varchar('sourceFingerprint', { length: 64 }).notNull(),
  sourceType: mysqlEnum('sourceType', ['website', 'api', 'dataset', 'publication', 'document']).notNull(),
  sourceUrl: varchar('sourceUrl', { length: 2048 }).notNull(),
  canonicalUrl: varchar('canonicalUrl', { length: 2048 }),
  sourceName: varchar('sourceName', { length: 300 }),
  domain: varchar('domain', { length: 253 }),
  language: varchar('language', { length: 24 }),
  region: varchar('region', { length: 80 }),
  discoveryMethod: mysqlEnum('discoveryMethod', ['owner_research', 'public_search', 'api_catalogue', 'licensed_import', 'customer_consent']).notNull(),
  robotsStatus: mysqlEnum('robotsStatus', ['unreviewed', 'reviewed_allow', 'reviewed_restrict', 'unavailable', 'not_applicable']).default('unreviewed').notNull(),
  robotsUrl: varchar('robotsUrl', { length: 2048 }),
  robotsEvidenceHash: varchar('robotsEvidenceHash', { length: 128 }),
  termsStatus: mysqlEnum('termsStatus', ['unreviewed', 'allows_research', 'allows_evaluation', 'allows_training', 'prohibits_automation', 'prohibits_training', 'unknown']).default('unreviewed').notNull(),
  termsUrl: varchar('termsUrl', { length: 2048 }),
  licenceReference: varchar('licenceReference', { length: 500 }),
  copyrightRisk: mysqlEnum('copyrightRisk', ['unreviewed', 'low', 'medium', 'high', 'blocked']).default('unreviewed').notNull(),
  piiStatus: mysqlEnum('piiStatus', ['unreviewed', 'none_detected', 'possible', 'restricted']).default('unreviewed').notNull(),
  allowedUse: mysqlEnum('allowedUse', ['research_only', 'evaluation_candidate', 'training_candidate', 'blocked']).default('research_only').notNull(),
  reviewStatus: mysqlEnum('reviewStatus', ['pending', 'approved', 'needs_policy_review', 'rejected', 'removed']).default('pending').notNull(),
  policyEvidence: json('policyEvidence').notNull(),
  reviewNote: text('reviewNote'),
  firstObservedAt: timestamp('firstObservedAt').notNull(),
  lastReviewedAt: timestamp('lastReviewedAt'),
  retentionUntil: timestamp('retentionUntil'),
  removalRequestedAt: timestamp('removalRequestedAt'),
  removedAt: timestamp('removedAt'),
  sourceCardVersion: varchar('sourceCardVersion', { length: 80 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('public_intelligence_source_fingerprint_unique').on(table.sourceFingerprint),
  index('public_intelligence_sources_owner_idx').on(table.ownerUserId),
  index('public_intelligence_sources_policy_idx').on(table.allowedUse, table.reviewStatus),
])

/** Append-only policy and reviewer ledger for source-card lifecycle decisions. */
export const publicIntelligenceSourceReviews = mysqlTable('publicIntelligenceSourceReviews', {
  id: int('id').autoincrement().primaryKey(),
  sourceId: int('sourceId').notNull().references(() => publicIntelligenceSources.id),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  action: mysqlEnum('action', ['created', 'reviewed', 'approved', 'use_changed', 'removed', 'restored']).notNull(),
  previousAllowedUse: mysqlEnum('previousAllowedUse', ['research_only', 'evaluation_candidate', 'training_candidate', 'blocked']),
  nextAllowedUse: mysqlEnum('nextAllowedUse', ['research_only', 'evaluation_candidate', 'training_candidate', 'blocked']).notNull(),
  previousReviewStatus: mysqlEnum('previousReviewStatus', ['pending', 'approved', 'needs_policy_review', 'rejected', 'removed']),
  nextReviewStatus: mysqlEnum('nextReviewStatus', ['pending', 'approved', 'needs_policy_review', 'rejected', 'removed']).notNull(),
  policySnapshot: json('policySnapshot').notNull(),
  reviewNote: text('reviewNote'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  index('public_intelligence_source_reviews_source_idx').on(table.sourceId, table.createdAt),
])

/** A versioned public-data representation. Raw network captures are deliberately not required: derived text, spans, structured features and human annotations remain independently reviewable. */
export const publicIntelligenceArtifacts = mysqlTable('publicIntelligenceArtifacts', {
  id: int('id').autoincrement().primaryKey(),
  sourceId: int('sourceId').notNull().references(() => publicIntelligenceSources.id),
  sourceUrl: varchar('sourceUrl', { length: 2048 }).notNull(),
  canonicalUrl: varchar('canonicalUrl', { length: 2048 }),
  artifactType: mysqlEnum('artifactType', ['page_manifest', 'structural_features', 'topic_map', 'entity_map', 'semantic_features', 'technical_seo', 'derived_excerpt', 'human_annotation']).notNull(),
  artifactText: text('artifactText'),
  sourceLocator: varchar('sourceLocator', { length: 1024 }),
  sourceSpanHash: varchar('sourceSpanHash', { length: 128 }),
  fieldData: json('fieldData').notNull(),
  artifactHash: varchar('artifactHash', { length: 128 }).notNull(),
  language: varchar('language', { length: 24 }),
  extractionMethod: mysqlEnum('extractionMethod', ['manual', 'public_api', 'policy_approved_fetch', 'human_annotation']).notNull(),
  extractionVersion: varchar('extractionVersion', { length: 80 }).notNull(),
  useSnapshot: mysqlEnum('useSnapshot', ['research_only', 'evaluation_candidate', 'training_candidate', 'blocked']).notNull(),
  qualityStatus: mysqlEnum('qualityStatus', ['pending', 'passed', 'needs_revision', 'rejected']).default('pending').notNull(),
  piiStatus: mysqlEnum('piiStatus', ['unreviewed', 'none_detected', 'possible', 'restricted']).default('unreviewed').notNull(),
  capturedAt: timestamp('capturedAt').notNull(),
  retentionUntil: timestamp('retentionUntil'),
  removedAt: timestamp('removedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('public_intelligence_artifact_hash_unique').on(table.artifactHash),
  index('public_intelligence_artifacts_source_idx').on(table.sourceId, table.artifactType),
  index('public_intelligence_artifacts_use_idx').on(table.useSnapshot, table.qualityStatus),
])

/** Append-only execution ledger for the daily, consent-gated model-improvement collector. */
export const modelImprovementCollectionRuns = mysqlTable('modelImprovementCollectionRuns', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  trigger: mysqlEnum('trigger', ['scheduled', 'owner_manual']).notNull(),
  status: mysqlEnum('status', ['running', 'completed', 'failed']).default('running').notNull(),
  leadsExamined: int('leadsExamined').default(0).notNull(),
  eligibleLeads: int('eligibleLeads').default(0).notNull(),
  collectedCandidates: int('collectedCandidates').default(0).notNull(),
  duplicateCandidates: int('duplicateCandidates').default(0).notNull(),
  skippedCandidates: int('skippedCandidates').default(0).notNull(),
  revokedCandidates: int('revokedCandidates').default(0).notNull(),
  failedCandidates: int('failedCandidates').default(0).notNull(),
  errorSummary: json('errorSummary').notNull(),
  startedAt: timestamp('startedAt').defaultNow().notNull(),
  completedAt: timestamp('completedAt'),
}, table => [
  index('model_improvement_collection_owner_idx').on(table.ownerUserId, table.startedAt),
  index('model_improvement_collection_status_idx').on(table.status, table.startedAt),
])

/** One de-identified structural snapshot per consented lead, held outside every training manifest until owner review. */
export const modelImprovementCandidates = mysqlTable('modelImprovementCandidates', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  leadId: int('leadId').notNull().references(() => leads.id),
  collectionRunId: int('collectionRunId').notNull().references(() => modelImprovementCollectionRuns.id),
  sourceUrl: varchar('sourceUrl', { length: 2048 }).notNull(),
  finalUrl: varchar('finalUrl', { length: 2048 }),
  hostname: varchar('hostname', { length: 253 }).notNull(),
  consentVersion: varchar('consentVersion', { length: 80 }).notNull(),
  consentedAt: timestamp('consentedAt').notNull(),
  consentRevokedAt: timestamp('consentRevokedAt'),
  status: mysqlEnum('status', ['collection_failed', 'ready_for_review', 'approved', 'rejected', 'revoked']).default('ready_for_review').notNull(),
  robotsStatus: mysqlEnum('robotsStatus', ['allowed', 'disallowed', 'unavailable', 'error']).notNull(),
  robotsCheckedAt: timestamp('robotsCheckedAt').notNull(),
  snapshotFingerprint: varchar('snapshotFingerprint', { length: 64 }),
  analysisVersion: varchar('analysisVersion', { length: 80 }).notNull(),
  featureData: json('featureData').notNull(),
  suggestedLabelData: json('suggestedLabelData').notNull(),
  approvedLabelData: json('approvedLabelData'),
  collectionErrorCode: varchar('collectionErrorCode', { length: 120 }),
  reviewerUserId: int('reviewerUserId').references(() => users.id),
  reviewNote: text('reviewNote'),
  publicSourceId: int('publicSourceId').references(() => publicIntelligenceSources.id),
  publicArtifactId: int('publicArtifactId').references(() => publicIntelligenceArtifacts.id),
  collectedAt: timestamp('collectedAt'),
  reviewedAt: timestamp('reviewedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('model_improvement_candidate_lead_unique').on(table.ownerUserId, table.leadId),
  index('model_improvement_candidate_status_idx').on(table.ownerUserId, table.status, table.createdAt),
  index('model_improvement_candidate_snapshot_idx').on(table.snapshotFingerprint),
])

/** Dataset manifests freeze exactly which policy-approved public representations entered a given evaluation or training build. */
export const publicIntelligenceDatasetBuilds = mysqlTable('publicIntelligenceDatasetBuilds', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  datasetName: varchar('datasetName', { length: 160 }).notNull(),
  datasetVersion: varchar('datasetVersion', { length: 80 }).notNull(),
  intendedUse: mysqlEnum('intendedUse', ['research', 'evaluation', 'training']).notNull(),
  policyFilter: json('policyFilter').notNull(),
  featureContractVersion: varchar('featureContractVersion', { length: 80 }).notNull(),
  labelTaxonomyVersion: varchar('labelTaxonomyVersion', { length: 80 }),
  splitVersion: varchar('splitVersion', { length: 80 }),
  manifestHash: varchar('manifestHash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['draft', 'ready_for_review', 'approved', 'archived', 'revoked']).default('draft').notNull(),
  reviewerUserId: int('reviewerUserId').references(() => users.id),
  reviewNote: text('reviewNote'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  approvedAt: timestamp('approvedAt'),
}, table => [
  uniqueIndex('public_intelligence_dataset_version_unique').on(table.datasetName, table.datasetVersion),
  index('public_intelligence_dataset_owner_idx').on(table.ownerUserId, table.status),
])

/** Many-to-many frozen member list with the exact reviewer decision that admitted an artifact to a specific dataset manifest. */
export const publicIntelligenceDatasetMembers = mysqlTable('publicIntelligenceDatasetMembers', {
  id: int('id').autoincrement().primaryKey(),
  datasetBuildId: int('datasetBuildId').notNull().references(() => publicIntelligenceDatasetBuilds.id),
  artifactId: int('artifactId').notNull().references(() => publicIntelligenceArtifacts.id),
  dataSplit: mysqlEnum('dataSplit', ['unassigned', 'train', 'validation', 'test', 'holdout']).default('unassigned').notNull(),
  inclusionReason: text('inclusionReason').notNull(),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  memberStatus: mysqlEnum('memberStatus', ['included', 'excluded', 'revoked']).default('included').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  revokedAt: timestamp('revokedAt'),
}, table => [
  uniqueIndex('public_intelligence_dataset_member_unique').on(table.datasetBuildId, table.artifactId),
  index('public_intelligence_dataset_members_artifact_idx').on(table.artifactId, table.memberStatus),
  ])

/** A bounded, owner-triggered public-document acquisition request. The body is processed in memory and never stored. */
export const publicIntelligenceIngestionJobs = mysqlTable('publicIntelligenceIngestionJobs', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  sourceId: int('sourceId').notNull().references(() => publicIntelligenceSources.id),
  requestedUrl: varchar('requestedUrl', { length: 2048 }).notNull(),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  collectionMode: mysqlEnum('collectionMode', ['owner_triggered_approved_fetch', 'owner_triggered_bounded_crawl']).notNull(),
  status: mysqlEnum('status', ['queued', 'processing', 'completed', 'duplicate', 'needs_human_review', 'policy_blocked', 'failed']).default('queued').notNull(),
  policySnapshot: json('policySnapshot').notNull(),
  finalUrl: varchar('finalUrl', { length: 2048 }),
  httpStatus: int('httpStatus'),
  contentHash: varchar('contentHash', { length: 128 }),
  cleanedTextHash: varchar('cleanedTextHash', { length: 128 }),
  responseByteLength: int('responseByteLength'),
  cleanedCharacterCount: int('cleanedCharacterCount'),
  piiOutcome: mysqlEnum('piiOutcome', ['not_detected', 'redacted', 'needs_human_review', 'blocked']).default('not_detected').notNull(),
  piiFindingCounts: json('piiFindingCounts').notNull(),
  extractorVersion: varchar('extractorVersion', { length: 80 }).notNull(),
  maxPages: int('maxPages'),
  maxDepth: int('maxDepth'),
  pagesFetched: int('pagesFetched').default(0).notNull(),
  pagesCleaned: int('pagesCleaned').default(0).notNull(),
  artifactsCreated: int('artifactsCreated').default(0).notNull(),
  crawlResults: json('crawlResults'),
  primaryArtifactId: int('primaryArtifactId').references(() => publicIntelligenceArtifacts.id),
  errorCode: varchar('errorCode', { length: 80 }),
  errorDetail: text('errorDetail'),
  requestedAt: timestamp('requestedAt').defaultNow().notNull(),
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
}, table => [
  index('public_intelligence_ingestion_owner_idx').on(table.ownerUserId, table.status),
  index('public_intelligence_ingestion_source_hash_idx').on(table.sourceId, table.contentHash),
])

/** A review-required result ledger for explainable baseline or approved model analyses. This is not a model-training record. */
/** A reproducible supervised-training run over human-approved, de-identified audit examples. Development runs are inspectable but never treated as production models. */
export const publicIntelligenceTrainingRuns = mysqlTable('publicIntelligenceTrainingRuns', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  datasetBuildId: int('datasetBuildId').references(() => publicIntelligenceDatasetBuilds.id),
  mode: mysqlEnum('mode', ['development', 'production']).notNull(),
  provider: mysqlEnum('provider', ['huggingface_jobs', 'google_colab_local']).default('huggingface_jobs').notNull(),
  modelFamily: mysqlEnum('modelFamily', ['huggingface_transformers']).notNull(),
  modelVersion: varchar('modelVersion', { length: 120 }).notNull(),
  featureContractVersion: varchar('featureContractVersion', { length: 80 }).notNull(),
  labelTaxonomyVersion: varchar('labelTaxonomyVersion', { length: 80 }).notNull(),
  splitVersion: varchar('splitVersion', { length: 80 }).notNull(),
  status: mysqlEnum('status', ['queued', 'running', 'completed', 'blocked', 'failed']).default('queued').notNull(),
  exampleCount: int('exampleCount').default(0).notNull(),
  trainCount: int('trainCount').default(0).notNull(),
  validationCount: int('validationCount').default(0).notNull(),
  testCount: int('testCount').default(0).notNull(),
  labelCounts: json('labelCounts').notNull(),
  metrics: json('metrics'),
  modelArtifact: json('modelArtifact'),
  remoteJobId: varchar('remoteJobId', { length: 160 }),
  remoteJobUrl: varchar('remoteJobUrl', { length: 500 }),
  baseModelId: varchar('baseModelId', { length: 300 }),
  modelRepoId: varchar('modelRepoId', { length: 300 }),
  datasetDigest: varchar('datasetDigest', { length: 128 }),
  errorCode: varchar('errorCode', { length: 120 }),
  errorDetail: text('errorDetail'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
}, table => [
  index('public_intelligence_training_owner_idx').on(table.ownerUserId, table.createdAt),
  index('public_intelligence_training_status_idx').on(table.status, table.mode),
])

/** A review-required result ledger for explainable baseline or approved model analyses. This is not a model-training record. */
export const publicIntelligenceInferences = mysqlTable('publicIntelligenceInferences', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  sourceId: int('sourceId').notNull().references(() => publicIntelligenceSources.id),
  ingestionJobId: int('ingestionJobId').references(() => publicIntelligenceIngestionJobs.id),
  artifactIds: json('artifactIds').notNull(),
  analysisKind: mysqlEnum('analysisKind', ['journey_friction_baseline', 'bge_m3_similarity']).notNull(),
  modelFamily: mysqlEnum('modelFamily', ['rule_baseline', 'bge_m3']).notNull(),
  modelVersion: varchar('modelVersion', { length: 120 }).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  output: json('output').notNull(),
  status: mysqlEnum('status', ['completed', 'needs_human_review', 'blocked', 'failed']).notNull(),
  requiresHumanReview: boolean('requiresHumanReview').default(true).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  index('public_intelligence_inference_owner_idx').on(table.ownerUserId, table.createdAt),
  index('public_intelligence_inference_job_idx').on(table.ingestionJobId),
])

/** Owner-scoped diagnosis ledger. Results are explainable baselines or explicitly not-ready model paths, never ranking or conversion measurements. */
export const seoGeoDiagnoses = mysqlTable('seoGeoDiagnoses', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  sourceId: int('sourceId').references(() => publicIntelligenceSources.id),
  auditRunId: int('auditRunId').references(() => auditRuns.id),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  diagnosisKind: mysqlEnum('diagnosisKind', ['deterministic_baseline', 'approved_model']).notNull(),
  status: mysqlEnum('status', ['completed', 'not_ready', 'needs_human_review', 'blocked', 'failed']).notNull(),
  modelReference: json('modelReference'),
  evidenceRefs: json('evidenceRefs').notNull(),
  result: json('result').notNull(),
  limitations: json('limitations').notNull(),
  requiresHumanReview: boolean('requiresHumanReview').default(true).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  index('seo_geo_diagnoses_owner_idx').on(table.ownerUserId, table.createdAt),
  index('seo_geo_diagnoses_source_idx').on(table.sourceId, table.inputFingerprint),
])

/** Explicit content-use approval for a reviewed source/artifact. Existing research or training permission is never silently treated as publishing permission. */
export const seoGeoEvidenceApprovals = mysqlTable('seoGeoEvidenceApprovals', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  sourceId: int('sourceId').notNull().references(() => publicIntelligenceSources.id),
  artifactId: int('artifactId').references(() => publicIntelligenceArtifacts.id),
  allowedFor: mysqlEnum('allowedFor', ['diagnosis', 'recommendation', 'content_draft']).notNull(),
  status: mysqlEnum('status', ['approved', 'restricted', 'revoked']).default('restricted').notNull(),
  policySnapshot: json('policySnapshot').notNull(),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  reviewNote: text('reviewNote'),
  approvedAt: timestamp('approvedAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('seo_geo_evidence_approval_unique').on(table.ownerUserId, table.sourceId, table.artifactId, table.allowedFor),
  index('seo_geo_evidence_approval_owner_idx').on(table.ownerUserId, table.status, table.allowedFor),
])

/** Versioned deterministic strategy recommendation derived from one owner diagnosis finding. */
export const seoGeoStrategyRecommendations = mysqlTable('seoGeoStrategyRecommendations', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  diagnosisId: int('diagnosisId').notNull().references(() => seoGeoDiagnoses.id),
  issueCode: varchar('issueCode', { length: 160 }).notNull(),
  recommendationKey: varchar('recommendationKey', { length: 160 }).notNull(),
  ruleSetVersion: varchar('ruleSetVersion', { length: 80 }).notNull(),
  ruleIds: json('ruleIds').notNull(),
  rules: json('rules').notNull(),
  priority: mysqlEnum('priority', ['high', 'medium', 'low']).notNull(),
  rationale: text('rationale').notNull(),
  recommendedActions: json('recommendedActions').notNull(),
  deliverableTypes: json('deliverableTypes').notNull(),
  contentOpportunities: json('contentOpportunities').notNull(),
  evidenceRefs: json('evidenceRefs').notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['proposed', 'selected', 'rejected', 'superseded']).default('proposed').notNull(),
  limitations: json('limitations').notNull(),
  version: int('version').default(1).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  provenance: json('provenance').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('seo_geo_strategy_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('seo_geo_strategy_version_unique').on(table.ownerUserId, table.diagnosisId, table.issueCode, table.version),
  index('seo_geo_strategy_owner_idx').on(table.ownerUserId, table.status, table.createdAt),
])

/** Owner selection of one strategy recommendation for a production plan. */
export const seoGeoProductionPlans = mysqlTable('seoGeoProductionPlans', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  diagnosisId: int('diagnosisId').references(() => seoGeoDiagnoses.id),
  title: varchar('title', { length: 300 }).notNull(),
  language: mysqlEnum('language', ['en', 'zh-hant']).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['draft', 'ready', 'generating', 'in_progress', 'completed', 'blocked', 'archived']).default('draft').notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  provenance: json('provenance').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('seo_geo_plan_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('seo_geo_plan_owner_idx').on(table.ownerUserId, table.status, table.createdAt),
])

/** Append-only selection ledger connecting an owner plan to deterministic strategy recommendations. */
export const seoGeoProductionPlanSelections = mysqlTable('seoGeoProductionPlanSelections', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  planId: int('planId').notNull().references(() => seoGeoProductionPlans.id),
  strategyRecommendationId: int('strategyRecommendationId').notNull().references(() => seoGeoStrategyRecommendations.id),
  status: mysqlEnum('status', ['selected', 'deselected']).default('selected').notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  provenance: json('provenance').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('seo_geo_plan_selection_unique').on(table.ownerUserId, table.planId, table.strategyRecommendationId),
  uniqueIndex('seo_geo_plan_selection_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('seo_geo_plan_selection_plan_idx').on(table.planId, table.status),
])

/** A reviewable creative brief whose claims may only draw on its immutable evidence snapshot. */
export const seoGeoContentBriefs = mysqlTable('seoGeoContentBriefs', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  diagnosisId: int('diagnosisId').references(() => seoGeoDiagnoses.id),
  strategyRecommendationId: int('strategyRecommendationId').references(() => seoGeoStrategyRecommendations.id),
  productionPlanId: int('productionPlanId').references(() => seoGeoProductionPlans.id),
  productionDeliverableId: int('productionDeliverableId'),
  ruleIds: json('ruleIds'),
  provenance: json('provenance'),
  title: varchar('title', { length: 300 }).notNull(),
  audience: varchar('audience', { length: 300 }).notNull(),
  contentType: mysqlEnum('contentType', ['article', 'service_page', 'faq', 'landing_page', 'brief']).notNull(),
  language: mysqlEnum('language', ['en', 'zh-hant']).notNull(),
  goals: json('goals').notNull(),
  constraints: json('constraints').notNull(),
  evidenceRefs: json('evidenceRefs').notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['draft', 'ready_for_generation', 'approved', 'superseded', 'archived']).default('draft').notNull(),
  reviewerUserId: int('reviewerUserId').references(() => users.id),
  reviewNote: text('reviewNote'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  index('seo_geo_content_briefs_owner_idx').on(table.ownerUserId, table.status, table.createdAt),
  index('seo_geo_content_briefs_diagnosis_idx').on(table.diagnosisId),
])

/** A bounded plan deliverable that can create exactly one evidence-bound Brief and Job. */
export const seoGeoProductionDeliverables = mysqlTable('seoGeoProductionDeliverables', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  planId: int('planId').notNull().references(() => seoGeoProductionPlans.id),
  selectionId: int('selectionId').notNull().references(() => seoGeoProductionPlanSelections.id),
  opportunityKey: varchar('opportunityKey', { length: 180 }).notNull(),
  contentType: mysqlEnum('contentType', ['article', 'service_page', 'faq']).notNull(),
  title: varchar('title', { length: 300 }).notNull(),
  audience: varchar('audience', { length: 300 }).notNull(),
  goals: json('goals').notNull(),
  constraints: json('constraints').notNull(),
  language: mysqlEnum('language', ['en', 'zh-hant']).notNull(),
  status: mysqlEnum('status', ['planned', 'brief_ready', 'job_queued', 'candidate_ready', 'needs_human_review', 'approved', 'blocked', 'exported']).default('planned').notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  briefId: int('briefId').references(() => seoGeoContentBriefs.id),
  jobId: int('jobId'),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  provenance: json('provenance').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('seo_geo_deliverable_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('seo_geo_deliverable_opportunity_unique').on(table.planId, table.opportunityKey),
  index('seo_geo_deliverable_plan_idx').on(table.planId, table.status),
])

/** Persisted, owner-triggered content operation. Autoscale runtime may process one request, but it never claims a durable worker exists. */
export const seoGeoContentJobs = mysqlTable('seoGeoContentJobs', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  briefId: int('briefId').notNull().references(() => seoGeoContentBriefs.id),
  productionPlanId: int('productionPlanId').references(() => seoGeoProductionPlans.id),
  strategyRecommendationId: int('strategyRecommendationId').references(() => seoGeoStrategyRecommendations.id),
  productionDeliverableId: int('productionDeliverableId').references(() => seoGeoProductionDeliverables.id),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  operation: mysqlEnum('operation', ['autogeo_recommendation', 'content_draft', 'risk_scan', 'delivery_preview', 'delivery_publish']).notNull(),
  providerMode: mysqlEnum('providerMode', ['reference_rules', 'autogeo_bailian_qwen', 'autogeo_api', 'manual']).notNull(),
  status: mysqlEnum('status', ['queued', 'processing', 'candidate_ready', 'needs_human_review', 'approved', 'blocked', 'failed', 'delivered']).default('queued').notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  providerProvenance: json('providerProvenance'),
  errorCode: varchar('errorCode', { length: 120 }),
  errorSummary: text('errorSummary'),
  requestedAt: timestamp('requestedAt').defaultNow().notNull(),
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
}, table => [
  uniqueIndex('seo_geo_content_jobs_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('seo_geo_content_jobs_brief_idx').on(table.briefId, table.status, table.requestedAt),
])

/** Versioned candidate content. A draft is never automatically published and always retains the provider and evidence snapshot. */
export const seoGeoContentDrafts = mysqlTable('seoGeoContentDrafts', {
  id: int('id').autoincrement().primaryKey(),
  jobId: int('jobId').notNull().references(() => seoGeoContentJobs.id),
  version: int('version').notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  body: text('body').notNull(),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  sourceMode: mysqlEnum('sourceMode', ['provider_candidate', 'reference_fallback', 'manual']).notNull(),
  provenance: json('provenance').notNull(),
  evidenceRefs: json('evidenceRefs').notNull(),
  safetyStatus: mysqlEnum('safetyStatus', ['passed', 'needs_review', 'blocked']).notNull(),
  safetyNotes: json('safetyNotes').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('seo_geo_content_drafts_version_unique').on(table.jobId, table.version),
  index('seo_geo_content_drafts_job_idx').on(table.jobId, table.createdAt),
])

/** A discrete quality/safety gate. Blocking findings prohibit delivery regardless of a prior review. */
export const seoGeoContentRiskGates = mysqlTable('seoGeoContentRiskGates', {
  id: int('id').autoincrement().primaryKey(),
  draftId: int('draftId').notNull().references(() => seoGeoContentDrafts.id),
  gateVersion: varchar('gateVersion', { length: 80 }).notNull(),
  status: mysqlEnum('status', ['passed', 'needs_human_review', 'blocked']).notNull(),
  findings: json('findings').notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [index('seo_geo_content_risk_gates_draft_idx').on(table.draftId, table.createdAt)])

/** Append-only human decisions. Only an explicit approved_for_delivery decision can unlock a delivery request. */
export const seoGeoContentReviews = mysqlTable('seoGeoContentReviews', {
  id: int('id').autoincrement().primaryKey(),
  jobId: int('jobId').notNull().references(() => seoGeoContentJobs.id),
  draftId: int('draftId').notNull().references(() => seoGeoContentDrafts.id),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  decision: mysqlEnum('decision', ['approved_for_preview', 'approved_for_delivery', 'changes_requested', 'rejected']).notNull(),
  reviewNote: text('reviewNote'),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [index('seo_geo_content_reviews_job_idx').on(table.jobId, table.createdAt)])

/** Allowed destination registry deliberately excludes credentials. A deployment adapter remains disabled unless separately configured server-side. */
export const seoGeoDeliveryTargets = mysqlTable('seoGeoDeliveryTargets', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  displayName: varchar('displayName', { length: 160 }).notNull(),
  adapter: mysqlEnum('adapter', ['manual_export', 'wordpress_rest', 'generic_http']).notNull(),
  targetOrigin: varchar('targetOrigin', { length: 2048 }).notNull(),
  status: mysqlEnum('status', ['disabled', 'review_required', 'enabled']).default('disabled').notNull(),
  allowPublish: boolean('allowPublish').default(false).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('seo_geo_delivery_target_owner_origin_unique').on(table.ownerUserId, table.targetOrigin),
  index('seo_geo_delivery_targets_owner_idx').on(table.ownerUserId, table.status),
])

/** Delivery ledger. V1 records previews and explicit delivery requests; adapters fail closed without separately configured server-only credentials. */
export const seoGeoDeliveryAttempts = mysqlTable('seoGeoDeliveryAttempts', {
  id: int('id').autoincrement().primaryKey(),
  jobId: int('jobId').notNull().references(() => seoGeoContentJobs.id),
  draftId: int('draftId').notNull().references(() => seoGeoContentDrafts.id),
  targetId: int('targetId').notNull().references(() => seoGeoDeliveryTargets.id),
  approvalReviewId: int('approvalReviewId').references(() => seoGeoContentReviews.id),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  mode: mysqlEnum('mode', ['preview', 'publish']).notNull(),
  status: mysqlEnum('status', ['prepared', 'blocked', 'delivered', 'failed']).notNull(),
  deliverySummary: json('deliverySummary').notNull(),
  externalReference: varchar('externalReference', { length: 500 }),
  errorCode: varchar('errorCode', { length: 120 }),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  completedAt: timestamp('completedAt'),
}, table => [
  uniqueIndex('seo_geo_delivery_attempt_idempotency_unique').on(table.targetId, table.idempotencyKey),
  index('seo_geo_delivery_attempts_job_idx').on(table.jobId, table.createdAt),
])

/** Owner-scoped client publication configuration. Credentials are deliberately not represented here. */
export const contentOperationClients = mysqlTable('contentOperationClients', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  displayName: varchar('displayName', { length: 160 }).notNull(),
  canonicalSiteOrigin: varchar('canonicalSiteOrigin', { length: 2048 }).notNull(),
  framework: mysqlEnum('framework', ['astro', 'nuxt']).notNull(),
  publicationTransport: mysqlEnum('publicationTransport', ['first_party_git', 'first_party_signed_api']).notNull(),
  timeZone: varchar('timeZone', { length: 80 }).notNull(),
  defaultCadenceDays: int('defaultCadenceDays').notNull(),
  defaultPublishLocalTime: varchar('defaultPublishLocalTime', { length: 5 }).notNull(),
  monthlyBudgetUnits: int('monthlyBudgetUnits').notNull(),
  status: mysqlEnum('status', ['active', 'paused', 'archived']).default('active').notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('content_operation_clients_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('content_operation_clients_owner_origin_unique').on(table.ownerUserId, table.canonicalSiteOrigin),
  index('content_operation_clients_owner_status_idx').on(table.ownerUserId, table.status),
])

/** Owner-scoped first-party publication configuration. Credential values never enter this table. */
export const contentOperationPublicationTargets = mysqlTable('contentOperationPublicationTargets', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  clientId: int('clientId').notNull().references(() => contentOperationClients.id),
  /** Server-derived website identity; never a credential or caller authority. */
  websiteId: varchar('websiteId', { length: 128 }).notNull().default('legacy-website'),
  targetId: varchar('targetId', { length: 128 }).notNull(),
  destinationPublicationIdentity: varchar('destinationPublicationIdentity', { length: 256 }).notNull().default('legacy-destination'),
  framework: mysqlEnum('framework', ['astro', 'nuxt', 'wordpress', 'php_agent', 'generic_http', 'geoflow_local', 'static_site']).notNull(),
  transport: mysqlEnum('transport', ['first_party_git', 'first_party_signed_api', 'wordpress_rest', 'geoflow_agent', 'generic_http', 'geoflow_local']).notNull(),
  targetOrigin: varchar('targetOrigin', { length: 2048 }).notNull(),
  contentRoot: varchar('contentRoot', { length: 256 }).notNull(),
  defaultBranch: varchar('defaultBranch', { length: 128 }),
  repositoryOwner: varchar('repositoryOwner', { length: 100 }),
  repositoryName: varchar('repositoryName', { length: 100 }),
  endpointPath: varchar('endpointPath', { length: 256 }),
  /** Opaque server-side service ref for GEOFlow agent/local routes; never a URL or secret. */
  serviceReference: varchar('serviceReference', { length: 128 }),
  credentialReference: varchar('credentialReference', { length: 128 }).notNull(),
  allowedContentTypes: json('allowedContentTypes').notNull(),
  allowedLanguages: json('allowedLanguages').notNull(),
  maximumPayloadBytes: int('maximumPayloadBytes').notNull(),
  status: mysqlEnum('status', ['active', 'paused', 'revoked']).default('active').notNull(),
  executionEnabled: boolean('executionEnabled').default(false).notNull(),
  /** Up to twenty active targets may occupy owner/client slots; paused and revoked targets use NULL. */
  activeSlot: int('activeSlot'),
  configurationFingerprint: varchar('configurationFingerprint', { length: 128 }).notNull(),
  provenance: json('provenance').notNull().default({}),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
  revokedAt: timestamp('revokedAt'),
}, table => [
  uniqueIndex('content_operation_targets_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('content_operation_targets_owner_target_unique').on(table.ownerUserId, table.targetId),
  uniqueIndex('content_operation_targets_owner_client_active_slot_unique').on(table.ownerUserId, table.clientId, table.activeSlot),
  index('content_operation_targets_owner_client_status_idx').on(table.ownerUserId, table.clientId, table.status),
  index('content_operation_targets_owner_website_idx').on(table.ownerUserId, table.websiteId),
])

/** Owner-scoped scheduler authorization; policy rows are revocable and never contain credential values. */
export const contentOperationAutopilotPolicies = mysqlTable('contentOperationAutopilotPolicies', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  clientId: int('clientId').notNull().references(() => contentOperationClients.id),
  publicationTargetId: int('publicationTargetId').notNull().references(() => contentOperationPublicationTargets.id),
  policyId: varchar('policyId', { length: 96 }).notNull(),
  policyVersion: varchar('policyVersion', { length: 96 }).notNull(),
  authorizedByOwnerUserId: int('authorizedByOwnerUserId').notNull().references(() => users.id),
  status: mysqlEnum('status', ['enabled', 'paused', 'revoked']).default('enabled').notNull(),
  authorizedAt: timestamp('authorizedAt').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  revokedAt: timestamp('revokedAt'),
  allowedContentTypes: json('allowedContentTypes').notNull(),
  allowedLanguages: json('allowedLanguages').notNull(),
  requireApprovedForDelivery: boolean('requireApprovedForDelivery').default(false).notNull(),
  requirePassedRiskGate: boolean('requirePassedRiskGate').default(true).notNull(),
  cadenceDays: int('cadenceDays').default(3).notNull(),
  evidenceFreshnessHours: int('evidenceFreshnessHours').default(720).notNull(),
  maximumRiskLevel: varchar('maximumRiskLevel', { length: 40 }).default('general').notNull(),
  requiredQualityGateVersion: varchar('requiredQualityGateVersion', { length: 96 }).default('content-risk-gate-v1').notNull(),
  allowedTargetIds: json('allowedTargetIds').notNull().default([]),
  allowedProviderModels: json('allowedProviderModels').notNull().default([]),
  activatedAt: timestamp('activatedAt').defaultNow().notNull(),
  configurationFingerprint: varchar('configurationFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('content_operation_autopilot_policy_id_unique').on(table.policyId),
  uniqueIndex('content_operation_autopilot_owner_target_unique').on(table.ownerUserId, table.publicationTargetId),
  index('content_operation_autopilot_owner_status_idx').on(table.ownerUserId, table.status, table.expiresAt),
])

/** Append-only first-party publication attempt ledger. Each retry is a new row. */
export const contentOperationPublicationAttempts = mysqlTable('contentOperationPublicationAttempts', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  clientId: int('clientId').notNull().references(() => contentOperationClients.id),
  entryId: int('entryId').notNull().references(() => contentOperationCalendarEntries.id),
  runId: int('runId').notNull().references(() => contentOperationRuns.id),
  targetId: int('targetId').notNull().references(() => contentOperationPublicationTargets.id),
  websiteId: varchar('websiteId', { length: 128 }),
  routingPlanId: varchar('routingPlanId', { length: 128 }),
  routeId: varchar('routeId', { length: 160 }),
  executorRunId: varchar('executorRunId', { length: 160 }),
  authorityReference: varchar('authorityReference', { length: 160 }),
  receiptFingerprint: varchar('receiptFingerprint', { length: 128 }),
  publicationUrl: varchar('publicationUrl', { length: 2048 }),
  receiptLedger: json('receiptLedger'),
  attemptNumber: int('attemptNumber').notNull(),
  mode: mysqlEnum('mode', ['dry_run', 'execute']).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  publicationId: varchar('publicationId', { length: 160 }).notNull(),
  publicationSlug: varchar('publicationSlug', { length: 160 }).notNull(),
  publicationPath: varchar('publicationPath', { length: 512 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  publicationContentHash: varchar('publicationContentHash', { length: 128 }),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  artifactFingerprint: varchar('artifactFingerprint', { length: 128 }),
  status: mysqlEnum('status', ['planned', 'dry_run_succeeded', 'delivered', 'retryable_failure', 'permanent_failure', 'blocked']).notNull(),
  remoteState: varchar('remoteState', { length: 64 }),
  remoteRevision: varchar('remoteRevision', { length: 256 }),
  errorCode: varchar('errorCode', { length: 120 }),
  errorSummary: varchar('errorSummary', { length: 500 }),
  startedAt: timestamp('startedAt').defaultNow().notNull(),
  completedAt: timestamp('completedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('content_operation_attempts_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('content_operation_attempts_owner_entry_idx').on(table.ownerUserId, table.entryId),
  index('content_operation_attempts_owner_status_idx').on(table.ownerUserId, table.status),
  index('content_operation_attempts_run_idx').on(table.runId),
  index('content_operation_attempts_target_idx').on(table.targetId),
])

/** Durable calendar snapshot produced only from the persisted SEO/GEO Production Plan. */
export const contentOperationCalendars = mysqlTable('contentOperationCalendars', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  clientId: int('clientId').notNull().references(() => contentOperationClients.id),
  productionPlanId: int('productionPlanId').notNull().references(() => seoGeoProductionPlans.id),
  engineVersion: varchar('engineVersion', { length: 96 }).notNull(),
  status: mysqlEnum('status', ['ready', 'partial', 'blocked', 'paused', 'archived']).default('ready').notNull(),
  planStartDate: varchar('planStartDate', { length: 10 }).notNull(),
  planEndDate: varchar('planEndDate', { length: 10 }).notNull(),
  timeZone: varchar('timeZone', { length: 80 }).notNull(),
  publishLocalTime: varchar('publishLocalTime', { length: 5 }).notNull(),
  cadenceDays: int('cadenceDays').notNull(),
  monthlyBudgetUnits: int('monthlyBudgetUnits').notNull(),
  defaultCostUnits: int('defaultCostUnits').notNull(),
  maxItemsPerCalendarMonth: int('maxItemsPerCalendarMonth').notNull(),
  maximumTotalItems: int('maximumTotalItems').notNull(),
  catchUpPolicy: mysqlEnum('catchUpPolicy', ['skip_missed', 'one_catch_up']).notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  revision: int('revision').notNull(),
  previousPlanFingerprint: varchar('previousPlanFingerprint', { length: 128 }),
  planFingerprint: varchar('planFingerprint', { length: 128 }).notNull(),
  normalizedRequestSnapshot: json('normalizedRequestSnapshot').notNull(),
  resultSnapshot: json('resultSnapshot').notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('content_operation_calendars_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('content_operation_calendars_owner_fingerprint_idx').on(table.ownerUserId, table.planFingerprint),
  index('content_operation_calendars_owner_status_idx').on(table.ownerUserId, table.status),
])

/** Durable entry projection; draft/review/content hash remain server-owned linkages. */
export const contentOperationCalendarEntries = mysqlTable('contentOperationCalendarEntries', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  calendarId: int('calendarId').notNull().references(() => contentOperationCalendars.id),
  productionDeliverableId: int('productionDeliverableId').notNull().references(() => seoGeoProductionDeliverables.id),
  strategyRecommendationId: int('strategyRecommendationId').notNull().references(() => seoGeoStrategyRecommendations.id),
  jobId: int('jobId').references(() => seoGeoContentJobs.id),
  draftId: int('draftId').references(() => seoGeoContentDrafts.id),
  reviewId: int('reviewId').references(() => seoGeoContentReviews.id),
  scheduleKey: varchar('scheduleKey', { length: 180 }).notNull(),
  plannedLocalDate: varchar('plannedLocalDate', { length: 10 }).notNull(),
  publishLocalTime: varchar('publishLocalTime', { length: 5 }).notNull(),
  timeZone: varchar('timeZone', { length: 80 }).notNull(),
  contentType: mysqlEnum('contentType', ['article', 'faq', 'service_page']).notNull(),
  language: mysqlEnum('language', ['en', 'zh-hant']).notNull(),
  topicCluster: varchar('topicCluster', { length: 128 }).notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }),
  publicationContentHash: varchar('publicationContentHash', { length: 128 }),
  /** Legacy single-target column retained for backward compatibility; bindings hold the authoritative set. */
  publicationTargetId: int('publicationTargetId').references(() => contentOperationPublicationTargets.id),
  publicationSlug: varchar('publicationSlug', { length: 160 }),
  publicationPath: varchar('publicationPath', { length: 512 }),
  publicationIdentityFingerprint: varchar('publicationIdentityFingerprint', { length: 128 }),
  publicationRoutingPlanId: varchar('publicationRoutingPlanId', { length: 128 }),
  publicationAuthorityReference: varchar('publicationAuthorityReference', { length: 160 }),
  publicationTargetCount: int('publicationTargetCount').default(0).notNull(),
  status: mysqlEnum('status', ['planned', 'materialized', 'awaiting_generation', 'awaiting_review', 'ready_to_publish', 'publishing', 'delivered', 'completed', 'cancelled', 'skipped', 'blocked']).default('planned').notNull(),
  engineEntryId: varchar('engineEntryId', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('content_operation_entries_calendar_engine_unique').on(table.calendarId, table.engineEntryId),
  uniqueIndex('content_operation_entries_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('content_operation_entries_owner_status_idx').on(table.ownerUserId, table.status, table.plannedLocalDate),
  index('content_operation_entries_calendar_status_idx').on(table.calendarId, table.status),
])

/** Owner-scoped 1–20 publication target bindings for a calendar entry. */
export const contentOperationCalendarEntryTargets = mysqlTable('contentOperationCalendarEntryTargets', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  clientId: int('clientId').notNull().references(() => contentOperationClients.id),
  entryId: int('entryId').notNull().references(() => contentOperationCalendarEntries.id),
  targetId: int('targetId').notNull().references(() => contentOperationPublicationTargets.id),
  slot: int('slot').notNull(),
  bindingFingerprint: varchar('bindingFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('content_operation_entry_targets_owner_entry_target_unique').on(table.ownerUserId, table.entryId, table.targetId),
  uniqueIndex('content_operation_entry_targets_owner_entry_slot_unique').on(table.ownerUserId, table.entryId, table.slot),
  index('content_operation_entry_targets_owner_client_idx').on(table.ownerUserId, table.clientId),
])

/** Staged, leaseable runtime state. Error summaries are sanitized application text only. */
export const contentOperationRuns = mysqlTable('contentOperationRuns', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  entryId: int('entryId').notNull().references(() => contentOperationCalendarEntries.id),
  stage: mysqlEnum('stage', ['generation', 'review_wait', 'publication', 'measurement', 'learning']).notNull(),
  state: mysqlEnum('state', ['queued', 'processing', 'retry_wait', 'succeeded', 'failed', 'blocked', 'cancelled']).default('queued').notNull(),
  attemptNumber: int('attemptNumber').notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  outputFingerprint: varchar('outputFingerprint', { length: 128 }),
  leaseOwner: varchar('leaseOwner', { length: 128 }),
  leaseExpiresAt: timestamp('leaseExpiresAt'),
  retryEligibleAt: timestamp('retryEligibleAt'),
  errorCode: varchar('errorCode', { length: 120 }),
  errorSummary: varchar('errorSummary', { length: 500 }),
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('content_operation_runs_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('content_operation_runs_entry_stage_idx').on(table.entryId, table.stage, table.state),
  index('content_operation_runs_lease_idx').on(table.entryId, table.stage, table.leaseExpiresAt),
])

/** Append-only operational audit ledger. There are intentionally no update/delete helpers. */
export const contentOperationEvents = mysqlTable('contentOperationEvents', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  clientId: int('clientId').references(() => contentOperationClients.id),
  calendarId: int('calendarId').references(() => contentOperationCalendars.id),
  entryId: int('entryId').references(() => contentOperationCalendarEntries.id),
  runId: int('runId').references(() => contentOperationRuns.id),
  websiteId: varchar('websiteId', { length: 128 }),
  deliverableId: int('deliverableId').references(() => seoGeoProductionDeliverables.id),
  draftId: int('draftId').references(() => seoGeoContentDrafts.id),
  routingPlanId: varchar('routingPlanId', { length: 128 }),
  routeId: varchar('routeId', { length: 160 }),
  executorRunId: varchar('executorRunId', { length: 160 }),
  contentHash: varchar('contentHash', { length: 128 }),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }),
  authorityReference: varchar('authorityReference', { length: 160 }),
  eventType: varchar('eventType', { length: 120 }).notNull(),
  fromStatus: varchar('fromStatus', { length: 80 }),
  toStatus: varchar('toStatus', { length: 80 }),
  eventFingerprint: varchar('eventFingerprint', { length: 128 }).notNull(),
  metadata: json('metadata').notNull(),
  occurredAt: timestamp('occurredAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('content_operation_events_owner_fingerprint_unique').on(table.ownerUserId, table.eventFingerprint),
  index('content_operation_events_owner_occurred_idx').on(table.ownerUserId, table.occurredAt),
  index('content_operation_events_entry_idx').on(table.entryId, table.occurredAt),
])

/** Bounded outcome snapshots only; crawled page bodies are intentionally excluded. */
export const contentOperationOutcomeAssessments = mysqlTable('contentOperationOutcomeAssessments', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  entryId: int('entryId').notNull().references(() => contentOperationCalendarEntries.id),
  runId: int('runId').references(() => contentOperationRuns.id),
  targetId: int('targetId').references(() => contentOperationPublicationTargets.id),
  draftId: int('draftId').references(() => seoGeoContentDrafts.id),
  publicationReceiptFingerprint: varchar('publicationReceiptFingerprint', { length: 128 }),
  publishedUrl: varchar('publishedUrl', { length: 2048 }),
  contentHash: varchar('contentHash', { length: 128 }),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }),
  assessmentStatus: varchar('assessmentStatus', { length: 40 }).notNull(),
  assessmentFingerprint: varchar('assessmentFingerprint', { length: 128 }).notNull(),
  baselineSnapshot: json('baselineSnapshot').notNull(),
  followUpSnapshot: json('followUpSnapshot').notNull(),
  assessmentSnapshot: json('assessmentSnapshot').notNull(),
  consentLineageSnapshot: json('consentLineageSnapshot').notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  measuredAt: timestamp('measuredAt').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('content_operation_outcomes_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('content_operation_outcomes_entry_idx').on(table.entryId, table.measuredAt),
])

/** Owner-only configuration for one bounded LLM observation workspace. It does not imply consumer-UI visibility. */
export const llmVisibilityProjects = mysqlTable('llmVisibilityProjects', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  name: varchar('name', { length: 160 }).notNull(),
  canonicalWebsiteUrl: varchar('canonicalWebsiteUrl', { length: 2048 }).notNull(),
  canonicalDomain: varchar('canonicalDomain', { length: 253 }).notNull(),
  locale: mysqlEnum('locale', ['en', 'zh-hant']).notNull(),
  brandName: varchar('brandName', { length: 160 }).notNull(),
  brandAliases: json('brandAliases').notNull(),
  competitorBrands: json('competitorBrands').notNull(),
  status: mysqlEnum('status', ['active', 'archived']).default('active').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  index('llm_visibility_projects_owner_idx').on(table.ownerUserId, table.status, table.createdAt),
  index('llm_visibility_projects_domain_idx').on(table.ownerUserId, table.canonicalDomain),
])

/** Fixed, owner-scoped prompts. The hash prevents duplicate tracking prompts within one project. */
export const llmVisibilityQueries = mysqlTable('llmVisibilityQueries', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => llmVisibilityProjects.id),
  promptText: text('promptText').notNull(),
  promptHash: varchar('promptHash', { length: 64 }).notNull(),
  intent: varchar('intent', { length: 120 }).notNull(),
  locale: mysqlEnum('locale', ['en', 'zh-hant']).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('llm_visibility_queries_project_prompt_unique').on(table.projectId, table.promptHash),
  index('llm_visibility_queries_owner_idx').on(table.ownerUserId, table.active, table.createdAt),
  index('llm_visibility_queries_project_idx').on(table.projectId, table.active),
])

/** One provider-labelled observation run; no provider executor or raw response is persisted. */
export const llmVisibilityRuns = mysqlTable('llmVisibilityRuns', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => llmVisibilityProjects.id),
  provider: mysqlEnum('provider', ['chatgpt', 'gemini', 'perplexity', 'google_ai_overview', 'manual_other']).notNull(),
  modelLabel: varchar('modelLabel', { length: 160 }).notNull(),
  observationMode: mysqlEnum('observationMode', ['manual_verified', 'provider_api_observation']).notNull(),
  status: mysqlEnum('status', ['queued', 'completed', 'blocked', 'failed']).notNull(),
  observedAt: timestamp('observedAt').notNull(),
  requestFingerprint: varchar('requestFingerprint', { length: 64 }).notNull(),
  limitationCode: varchar('limitationCode', { length: 120 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('llm_visibility_runs_owner_fingerprint_unique').on(table.ownerUserId, table.requestFingerprint),
  index('llm_visibility_runs_owner_idx').on(table.ownerUserId, table.observedAt),
  index('llm_visibility_runs_project_idx').on(table.projectId, table.observedAt),
])

/** Bounded, structured evidence only. Full provider responses are intentionally excluded from this schema. */
export const llmVisibilityObservations = mysqlTable('llmVisibilityObservations', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => llmVisibilityProjects.id),
  runId: int('runId').notNull().references(() => llmVisibilityRuns.id),
  queryId: int('queryId').notNull().references(() => llmVisibilityQueries.id),
  brandMentioned: boolean('brandMentioned').notNull(),
  exactMentionCount: int('exactMentionCount').notNull(),
  firstMentionPosition: int('firstMentionPosition'),
  citedDomain: varchar('citedDomain', { length: 253 }),
  citationUrls: json('citationUrls').notNull(),
  competitorMentions: json('competitorMentions').notNull(),
  boundedExcerpt: text('boundedExcerpt').notNull(),
  responseHash: varchar('responseHash', { length: 64 }).notNull(),
  evidenceLocator: varchar('evidenceLocator', { length: 1000 }).notNull(),
  reviewerNote: text('reviewerNote').notNull(),
  verifiedByOwner: boolean('verifiedByOwner').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('llm_visibility_observations_run_query_unique').on(table.runId, table.queryId),
  index('llm_visibility_observations_owner_idx').on(table.ownerUserId, table.createdAt),
  index('llm_visibility_observations_project_idx').on(table.projectId, table.createdAt),
  index('llm_visibility_observations_run_idx').on(table.runId),
  index('llm_visibility_observations_query_idx').on(table.queryId),
])

/** Append-only owner decisions for imported manual snapshots. Legacy booleans are never authority. */
export const llmVisibilityObservationReviews = mysqlTable('llmVisibilityObservationReviews', {
  id: int('id').autoincrement().primaryKey(),
  decisionId: varchar('decisionId', { length: 160 }).notNull(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  observationId: int('observationId').notNull().references(() => llmVisibilityObservations.id),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  previousStatus: mysqlEnum('previousStatus', ['pending', 'approved', 'revoked']).notNull(),
  newStatus: mysqlEnum('newStatus', ['approved', 'revoked']).notNull(),
  reason: varchar('reason', { length: 500 }).notNull(),
  sourceResponseHash: varchar('sourceResponseHash', { length: 64 }).notNull(),
  decisionFingerprint: varchar('decisionFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('llm_visibility_reviews_decision_unique').on(table.decisionId),
  uniqueIndex('llm_visibility_reviews_owner_key_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('llm_visibility_reviews_observation_status_unique').on(table.observationId, table.newStatus),
  index('llm_visibility_reviews_owner_observation_idx').on(table.ownerUserId, table.observationId, table.createdAt),
])

/** Owner-scoped measurement source connection. Only opaque credential references are persisted. */
export const contentOperationMeasurementConnections = mysqlTable('contentOperationMeasurementConnections', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  clientId: int('clientId').notNull().references(() => contentOperationClients.id),
  publicationTargetId: int('publicationTargetId').references(() => contentOperationPublicationTargets.id),
  /** Server-derived target/origin identity used for one live source per measured website. */
  websiteIdentity: varchar('websiteIdentity', { length: 160 }).notNull(),
  source: mysqlEnum('source', ['google_search_console', 'first_party_analytics', 'llm_visibility']).notNull(),
  /** Mirrors source while the connection is live; NULL after revocation enables immutable replacement rows. */
  activeSource: mysqlEnum('activeSource', ['google_search_console', 'first_party_analytics', 'llm_visibility']),
  status: mysqlEnum('status', ['configured', 'paused', 'revoked', 'needs_reauthorization']).default('configured').notNull(),
  /** Opaque server-side reference only; OAuth tokens, API keys, and headers are never stored. */
  credentialReference: varchar('credentialReference', { length: 128 }),
  googleSearchConsoleProperty: varchar('googleSearchConsoleProperty', { length: 2048 }),
  ga4PropertyId: varchar('ga4PropertyId', { length: 12 }),
  llmVisibilityProjectId: int('llmVisibilityProjectId').references(() => llmVisibilityProjects.id),
  canonicalOrigin: varchar('canonicalOrigin', { length: 2048 }).notNull(),
  timeZone: varchar('timeZone', { length: 80 }).notNull(),
  allowedPageScope: json('allowedPageScope').notNull(),
  sourceAvailabilityLagDays: int('sourceAvailabilityLagDays').notNull().default(0),
  providerTargets: json('providerTargets'),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  configurationFingerprint: varchar('configurationFingerprint', { length: 128 }).notNull(),
  connectedAt: timestamp('connectedAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('measurement_connections_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('measurement_connections_owner_website_active_source_unique').on(table.ownerUserId, table.websiteIdentity, table.activeSource),
  index('measurement_connections_owner_status_idx').on(table.ownerUserId, table.status),
  index('measurement_connections_owner_client_idx').on(table.ownerUserId, table.clientId),
])

/** One durable source/checkpoint publication measurement run. Claims are leaseable and idempotent. */
export const contentOperationMeasurementRuns = mysqlTable('contentOperationMeasurementRuns', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  clientId: int('clientId').notNull().references(() => contentOperationClients.id),
  connectionId: int('connectionId').notNull().references(() => contentOperationMeasurementConnections.id),
  entryId: int('entryId').notNull().references(() => contentOperationCalendarEntries.id),
  targetId: int('targetId').notNull().references(() => contentOperationPublicationTargets.id),
  source: mysqlEnum('source', ['google_search_console', 'first_party_analytics', 'llm_visibility']).notNull(),
  checkpointDays: int('checkpointDays').notNull(),
  publicationReceiptFingerprint: varchar('publicationReceiptFingerprint', { length: 128 }).notNull(),
  canonicalPage: varchar('canonicalPage', { length: 2048 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  publicationLocalDate: varchar('publicationLocalDate', { length: 10 }).notNull(),
  timeZone: varchar('timeZone', { length: 80 }).notNull(),
  baselineWindowStart: timestamp('baselineWindowStart').notNull(),
  baselineWindowEnd: timestamp('baselineWindowEnd').notNull(),
  followUpWindowStart: timestamp('followUpWindowStart').notNull(),
  followUpWindowEnd: timestamp('followUpWindowEnd').notNull(),
  dueAt: timestamp('dueAt').notNull(),
  state: mysqlEnum('state', ['queued', 'processing', 'retry_wait', 'succeeded', 'insufficient_data', 'blocked', 'failed', 'cancelled']).default('queued').notNull(),
  attemptNumber: int('attemptNumber').notNull().default(0),
  leaseOwner: varchar('leaseOwner', { length: 128 }),
  leaseExpiresAt: timestamp('leaseExpiresAt'),
  retryEligibleAt: timestamp('retryEligibleAt'),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  outputFingerprint: varchar('outputFingerprint', { length: 128 }),
  errorCode: varchar('errorCode', { length: 120 }),
  errorSummary: varchar('errorSummary', { length: 500 }),
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('measurement_runs_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('measurement_runs_owner_pair_unique').on(table.ownerUserId, table.entryId, table.targetId, table.source, table.checkpointDays, table.baselineWindowStart, table.followUpWindowStart, table.publicationReceiptFingerprint, table.contentHash, table.evidenceSnapshotHash),
  index('measurement_runs_owner_due_idx').on(table.ownerUserId, table.state, table.dueAt),
  index('measurement_runs_connection_idx').on(table.connectionId, table.state),
  index('measurement_runs_entry_checkpoint_idx').on(table.ownerUserId, table.entryId, table.checkpointDays),
  index('measurement_runs_lease_idx').on(table.state, table.leaseExpiresAt),
])

/** Append-only normalized measurement snapshot. There are intentionally no update/delete helpers. */
export const contentOperationMeasurementSnapshots = mysqlTable('contentOperationMeasurementSnapshots', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  runId: int('runId').notNull().references(() => contentOperationMeasurementRuns.id),
  entryId: int('entryId').notNull().references(() => contentOperationCalendarEntries.id),
  targetId: int('targetId').notNull().references(() => contentOperationPublicationTargets.id),
  source: mysqlEnum('source', ['google_search_console', 'first_party_analytics', 'llm_visibility']).notNull(),
  phase: mysqlEnum('phase', ['baseline', 'follow_up']).notNull(),
  deidentifiedSubjectKey: varchar('deidentifiedSubjectKey', { length: 64 }).notNull(),
  scopeFingerprint: varchar('scopeFingerprint', { length: 128 }).notNull(),
  windowStart: timestamp('windowStart').notNull(),
  windowEnd: timestamp('windowEnd').notNull(),
  capturedAt: timestamp('capturedAt').notNull(),
  sourceHash: varchar('sourceHash', { length: 128 }).notNull(),
  normalizedMetrics: json('normalizedMetrics').notNull(),
  providerProvenance: json('providerProvenance').notNull(),
  limitations: json('limitations').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('measurement_snapshots_run_phase_unique').on(table.runId, table.phase),
  uniqueIndex('measurement_snapshots_owner_source_hash_unique').on(table.ownerUserId, table.sourceHash),
  index('measurement_snapshots_owner_entry_idx').on(table.ownerUserId, table.entryId, table.createdAt),
  index('measurement_snapshots_run_idx').on(table.runId),
])

export type User = typeof users.$inferSelect
export type ProviderCredentials = typeof providerCredentials.$inferSelect
export type Lead = typeof leads.$inferSelect
export type AuditWorkspace = typeof auditWorkspaces.$inferSelect
export type AuditRun = typeof auditRuns.$inferSelect
export type AuditObservation = typeof auditObservations.$inferSelect
export type FrictionAssessment = typeof frictionAssessments.$inferSelect
export type AuditReview = typeof auditReviews.$inferSelect
export type AuditTrainingExample = typeof auditTrainingExamples.$inferSelect
export type PublicIntelligenceSource = typeof publicIntelligenceSources.$inferSelect
export type PublicIntelligenceSourceReview = typeof publicIntelligenceSourceReviews.$inferSelect
export type PublicIntelligenceArtifact = typeof publicIntelligenceArtifacts.$inferSelect
export type ModelImprovementCollectionRun = typeof modelImprovementCollectionRuns.$inferSelect
export type ModelImprovementCandidate = typeof modelImprovementCandidates.$inferSelect
export type PublicIntelligenceDatasetBuild = typeof publicIntelligenceDatasetBuilds.$inferSelect
export type PublicIntelligenceIngestionJob = typeof publicIntelligenceIngestionJobs.$inferSelect
export type PublicIntelligenceInference = typeof publicIntelligenceInferences.$inferSelect
export type SeoGeoDiagnosis = typeof seoGeoDiagnoses.$inferSelect
export type SeoGeoEvidenceApproval = typeof seoGeoEvidenceApprovals.$inferSelect
export type SeoGeoContentBrief = typeof seoGeoContentBriefs.$inferSelect
export type SeoGeoContentJob = typeof seoGeoContentJobs.$inferSelect
export type SeoGeoContentDraft = typeof seoGeoContentDrafts.$inferSelect
export type SeoGeoContentRiskGate = typeof seoGeoContentRiskGates.$inferSelect
export type SeoGeoContentReview = typeof seoGeoContentReviews.$inferSelect
export type SeoGeoDeliveryTarget = typeof seoGeoDeliveryTargets.$inferSelect
export type SeoGeoDeliveryAttempt = typeof seoGeoDeliveryAttempts.$inferSelect
export type LlmVisibilityProject = typeof llmVisibilityProjects.$inferSelect
export type LlmVisibilityQuery = typeof llmVisibilityQueries.$inferSelect
export type LlmVisibilityRun = typeof llmVisibilityRuns.$inferSelect
export type LlmVisibilityObservation = typeof llmVisibilityObservations.$inferSelect


/** Managed site project vault. The project stores canonical identity and references, never platform source code. */
export const managedSiteProjects = mysqlTable('managedSiteProjects', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  canonicalClientIdentity: varchar('canonicalClientIdentity', { length: 160 }).notNull(),
  canonicalWebsiteIdentity: varchar('canonicalWebsiteIdentity', { length: 2048 }).notNull(),
  contentOperationClientId: int('contentOperationClientId').references(() => contentOperationClients.id),
  status: mysqlEnum('status', ['draft', 'quoted', 'awaiting_customer_authorization', 'payment_pending', 'payment_verified', 'domain_intent_created', 'domain_purchase_pending', 'domain_registered', 'dns_pending', 'dns_verified', 'build_pending', 'building', 'deployment_failed', 'deployed', 'tls_pending', 'active', 'retry_wait', 'blocked', 'suspended']).default('draft').notNull(),
  siteType: mysqlEnum('siteType', ['one_page', 'brand_blog', 'simple_commerce']).notNull(),
  activeVersionId: int('activeVersionId'),
  catalogVersion: varchar('catalogVersion', { length: 96 }).notNull(),
  subscriptionReference: varchar('subscriptionReference', { length: 160 }),
  projectFingerprint: varchar('projectFingerprint', { length: 128 }).notNull(),
  creationIdempotencyKey: varchar('creationIdempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_projects_owner_client_identity_unique').on(table.ownerUserId, table.canonicalClientIdentity),
  uniqueIndex('managed_site_projects_owner_website_identity_unique').on(table.ownerUserId, table.canonicalWebsiteIdentity),
  uniqueIndex('managed_site_projects_owner_fingerprint_unique').on(table.ownerUserId, table.projectFingerprint),
  uniqueIndex('managed_site_projects_owner_creation_idempotency_unique').on(table.ownerUserId, table.creationIdempotencyKey),
  index('managed_site_projects_owner_status_idx').on(table.ownerUserId, table.status),
])

/** Immutable version snapshots; SiteSpec and design tokens are opaque JSON snapshots, never executable source. */
export const managedSiteVersions = mysqlTable('managedSiteVersions', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  version: int('version').notNull(),
  siteSpecSnapshot: json('siteSpecSnapshot').notNull(),
  designTokenSnapshot: json('designTokenSnapshot').notNull(),
  selectedModuleSnapshot: json('selectedModuleSnapshot').notNull(),
  contentFingerprint: varchar('contentFingerprint', { length: 128 }).notNull(),
  parentVersionId: int('parentVersionId'),
  lifecycleStatus: mysqlEnum('lifecycleStatus', ['draft', 'preview', 'active', 'superseded', 'archived']).default('draft').notNull(),
  createdByAuthority: varchar('createdByAuthority', { length: 160 }).notNull(),
  versionFingerprint: varchar('versionFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_versions_project_version_unique').on(table.projectId, table.version),
  uniqueIndex('managed_site_versions_project_fingerprint_unique').on(table.projectId, table.versionFingerprint),
  index('managed_site_versions_owner_project_idx').on(table.ownerUserId, table.projectId, table.createdAt),
])

/** Asset metadata only. The actual bytes live behind an opaque storage reference. */
export const managedSiteAssets = mysqlTable('managedSiteAssets', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  assetHash: varchar('assetHash', { length: 128 }).notNull(),
  mimeType: varchar('mimeType', { length: 160 }).notNull(),
  byteSize: int('byteSize').notNull(),
  purpose: varchar('purpose', { length: 120 }).notNull(),
  storageReference: varchar('storageReference', { length: 512 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_assets_project_hash_unique').on(table.projectId, table.assetHash),
  index('managed_site_assets_owner_project_idx').on(table.ownerUserId, table.projectId),
])

/** Fixed role membership within a project tenant. */
export const managedSiteMemberships = mysqlTable('managedSiteMemberships', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  principalEmail: varchar('principalEmail', { length: 320 }).notNull(),
  userId: int('userId').references(() => users.id),
  role: mysqlEnum('role', ['owner', 'administrator', 'editor', 'reviewer', 'analyst']).notNull(),
  status: mysqlEnum('status', ['active', 'revoked']).default('active').notNull(),
  invitedAt: timestamp('invitedAt').defaultNow().notNull(),
  acceptedAt: timestamp('acceptedAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_memberships_project_email_unique').on(table.projectId, table.principalEmail),
  index('managed_site_memberships_owner_project_status_idx').on(table.ownerUserId, table.projectId, table.status),
])

/** Single-use invitation ledger. Only a hash of the bearer token is stored. */
export const managedSiteInvitations = mysqlTable('managedSiteInvitations', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  membershipId: int('membershipId').notNull().references(() => managedSiteMemberships.id),
  recipientEmail: varchar('recipientEmail', { length: 320 }).notNull(),
  role: mysqlEnum('role', ['owner', 'administrator', 'editor', 'reviewer', 'analyst']).notNull(),
  tokenHash: varchar('tokenHash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['pending', 'accepted', 'revoked', 'expired']).default('pending').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  acceptedAt: timestamp('acceptedAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_invitations_token_hash_unique').on(table.tokenHash),
  index('managed_site_invitations_owner_project_status_idx').on(table.ownerUserId, table.projectId, table.status),
])

/** Append-only project audit ledger. Sensitive credentials and full payloads are never stored. */
export const managedSiteAuditEvents = mysqlTable('managedSiteAuditEvents', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  actorUserId: int('actorUserId').references(() => users.id),
  authority: varchar('authority', { length: 160 }).notNull(),
  action: varchar('action', { length: 160 }).notNull(),
  beforeFingerprint: varchar('beforeFingerprint', { length: 128 }),
  afterFingerprint: varchar('afterFingerprint', { length: 128 }),
  eventFingerprint: varchar('eventFingerprint', { length: 128 }).notNull(),
  metadata: json('metadata').notNull(),
  occurredAt: timestamp('occurredAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_audit_owner_event_unique').on(table.ownerUserId, table.eventFingerprint),
  index('managed_site_audit_owner_project_time_idx').on(table.ownerUserId, table.projectId, table.occurredAt),
])

/** Subscription lifecycle projection; cancellation never implies data deletion. */
export const managedSiteSubscriptions = mysqlTable('managedSiteSubscriptions', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  planKey: varchar('planKey', { length: 96 }).notNull(),
  status: mysqlEnum('status', ['active', 'past_due', 'grace_period', 'suspended', 'terminated']).default('active').notNull(),
  subscriptionReference: varchar('subscriptionReference', { length: 160 }),
  gracePeriodEndsAt: timestamp('gracePeriodEndsAt'),
  termEndsAt: timestamp('termEndsAt'),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  stateFingerprint: varchar('stateFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_subscriptions_project_unique').on(table.projectId),
  uniqueIndex('managed_site_subscriptions_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('managed_site_subscriptions_owner_status_idx').on(table.ownerUserId, table.status),
])

/** Short-lived customer portal sessions issued after a single-use invitation is accepted. Only a hash is stored. */
export const managedSiteSessions = mysqlTable('managedSiteSessions', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  membershipId: int('membershipId').notNull().references(() => managedSiteMemberships.id),
  sessionHash: varchar('sessionHash', { length: 128 }).notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  lastSeenAt: timestamp('lastSeenAt'),
}, table => [
  uniqueIndex('managed_site_sessions_hash_unique').on(table.sessionHash),
  index('managed_site_sessions_owner_project_idx').on(table.ownerUserId, table.projectId, table.expiresAt),
])

export type ManagedSiteProject = typeof managedSiteProjects.$inferSelect
export type ManagedSiteVersion = typeof managedSiteVersions.$inferSelect
export type ManagedSiteAsset = typeof managedSiteAssets.$inferSelect
export type ManagedSiteMembership = typeof managedSiteMemberships.$inferSelect
export type ManagedSiteInvitation = typeof managedSiteInvitations.$inferSelect
export type ManagedSiteAuditEvent = typeof managedSiteAuditEvents.$inferSelect
export type ManagedSiteSubscription = typeof managedSiteSubscriptions.$inferSelect
export type ManagedSiteSession = typeof managedSiteSessions.$inferSelect


/** Anonymous or owner-associated preview draft. Only validated SiteSpec/style snapshots are persisted. */
export const managedSitePreviews = mysqlTable('managedSitePreviews', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').references(() => users.id),
  draftKey: varchar('draftKey', { length: 160 }).notNull(),
  accessTokenHash: varchar('accessTokenHash', { length: 128 }).notNull(),
  sourceMode: mysqlEnum('sourceMode', ['new_site', 'existing_site']).notNull(),
  existingSiteUrl: varchar('existingSiteUrl', { length: 2048 }),
  brief: text('brief').notNull(),
  businessGoals: json('businessGoals').notNull(),
  styleProfile: json('styleProfile').notNull(),
  siteSpecSnapshot: json('siteSpecSnapshot').notNull(),
  designTokenSnapshot: json('designTokenSnapshot').notNull(),
  selectedModuleSnapshot: json('selectedModuleSnapshot').notNull(),
  previewFingerprint: varchar('previewFingerprint', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['draft', 'generated', 'saved', 'expired', 'converted']).default('generated').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_previews_draft_key_unique').on(table.draftKey),
  uniqueIndex('managed_site_previews_access_token_unique').on(table.accessTokenHash),
  uniqueIndex('managed_site_previews_fingerprint_unique').on(table.previewFingerprint),
  index('managed_site_previews_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
])

/** Server-priced immutable quote bound to one preview snapshot and fixed catalog. */
export const managedSiteQuotes = mysqlTable('managedSiteQuotes', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').references(() => users.id),
  previewId: int('previewId').notNull().references(() => managedSitePreviews.id),
  projectId: int('projectId').references(() => managedSiteProjects.id),
  quoteVersion: varchar('quoteVersion', { length: 96 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  planKey: varchar('planKey', { length: 96 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  totalMinor: int('totalMinor').notNull(),
  taxStatus: mysqlEnum('taxStatus', ['not_calculated', 'limited']).notNull(),
  moduleSnapshot: json('moduleSnapshot').notNull(),
  cadenceDays: int('cadenceDays').notNull(),
  domainOption: mysqlEnum('domainOption', ['existing', 'new', 'assisted']).notNull(),
  siteSpecFingerprint: varchar('siteSpecFingerprint', { length: 128 }).notNull(),
  quoteFingerprint: varchar('quoteFingerprint', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['draft', 'quoted', 'expired', 'locked', 'cancelled']).default('quoted').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  lockedAt: timestamp('lockedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_quotes_preview_idempotency_unique').on(table.previewId, table.idempotencyKey),
  uniqueIndex('managed_site_quotes_fingerprint_unique').on(table.quoteFingerprint),
  index('managed_site_quotes_preview_status_idx').on(table.previewId, table.status),
  index('managed_site_quotes_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
])

/** Immutable quote line items generated only from the server-side price catalog. */
export const managedSiteQuoteLines = mysqlTable('managedSiteQuoteLines', {
  id: int('id').autoincrement().primaryKey(),
  quoteId: int('quoteId').notNull().references(() => managedSiteQuotes.id),
  lineKey: varchar('lineKey', { length: 96 }).notNull(),
  description: varchar('description', { length: 300 }).notNull(),
  quantity: int('quantity').notNull(),
  unitAmountMinor: int('unitAmountMinor').notNull(),
  lineAmountMinor: int('lineAmountMinor').notNull(),
  catalogVersion: varchar('catalogVersion', { length: 96 }).notNull(),
  lineFingerprint: varchar('lineFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_quote_lines_quote_key_unique').on(table.quoteId, table.lineKey),
  index('managed_site_quote_lines_quote_idx').on(table.quoteId),
])

/** Links an existing canonical lead record to a managed-site preview and quote. */
export const managedSiteLeadIntents = mysqlTable('managedSiteLeadIntents', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').references(() => users.id),
  previewId: int('previewId').notNull().references(() => managedSitePreviews.id),
  quoteId: int('quoteId').references(() => managedSiteQuotes.id),
  leadId: int('leadId').notNull().references(() => leads.id),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_lead_intents_preview_idempotency_unique').on(table.previewId, table.idempotencyKey),
  uniqueIndex('managed_site_lead_intents_request_unique').on(table.requestFingerprint),
  index('managed_site_lead_intents_preview_idx').on(table.previewId, table.createdAt),
])

/** Draft order created from an exact quote and lead; it is never marked paid by public input. */
export const managedSiteDraftOrders = mysqlTable('managedSiteDraftOrders', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').references(() => users.id),
  previewId: int('previewId').notNull().references(() => managedSitePreviews.id),
  quoteId: int('quoteId').notNull().references(() => managedSiteQuotes.id),
  projectId: int('projectId').references(() => managedSiteProjects.id),
  leadId: int('leadId').notNull().references(() => leads.id),
  status: mysqlEnum('status', ['draft', 'payment_pending', 'payment_verified', 'cancelled', 'expired']).default('draft').notNull(),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  paymentIntentReference: varchar('paymentIntentReference', { length: 160 }),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_draft_orders_preview_idempotency_unique').on(table.previewId, table.idempotencyKey),
  uniqueIndex('managed_site_draft_orders_request_unique').on(table.requestFingerprint),
  index('managed_site_draft_orders_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
])

/** Append-only verified payment event ledger. Provider payloads are reduced to safe references and fingerprints. */
export const managedSitePaymentEvents = mysqlTable('managedSitePaymentEvents', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  draftOrderId: int('draftOrderId').notNull().references(() => managedSiteDraftOrders.id),
  previewId: int('previewId').notNull().references(() => managedSitePreviews.id),
  quoteId: int('quoteId').notNull().references(() => managedSiteQuotes.id),
  providerKey: varchar('providerKey', { length: 96 }).notNull(),
  eventId: varchar('eventId', { length: 160 }).notNull(),
  providerReference: varchar('providerReference', { length: 160 }).notNull(),
  eventType: varchar('eventType', { length: 96 }).notNull(),
  amountMinor: int('amountMinor').notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  canonicalPayloadHash: varchar('canonicalPayloadHash', { length: 128 }).notNull(),
  verificationStatus: mysqlEnum('verificationStatus', ['verified', 'rejected', 'replayed']).notNull(),
  eventFingerprint: varchar('eventFingerprint', { length: 128 }).notNull(),
  receivedAt: timestamp('receivedAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_payment_events_owner_provider_event_unique').on(table.ownerUserId, table.providerKey, table.eventId),
  uniqueIndex('managed_site_payment_events_fingerprint_unique').on(table.ownerUserId, table.eventFingerprint),
  index('managed_site_payment_events_order_idx').on(table.draftOrderId, table.receivedAt),
])

/** Subscription entitlement intent bound to the exact quote cadence and plan. */
export const managedSiteSubscriptionIntents = mysqlTable('managedSiteSubscriptionIntents', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').references(() => users.id),
  projectId: int('projectId').references(() => managedSiteProjects.id),
  quoteId: int('quoteId').notNull().references(() => managedSiteQuotes.id),
  planKey: varchar('planKey', { length: 96 }).notNull(),
  cadenceDays: int('cadenceDays').notNull(),
  termMonths: int('termMonths').notNull(),
  status: mysqlEnum('status', ['draft', 'entitled', 'blocked']).default('draft').notNull(),
  intentFingerprint: varchar('intentFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_subscription_intents_quote_unique').on(table.quoteId),
  uniqueIndex('managed_site_subscription_intents_fingerprint_unique').on(table.intentFingerprint),
  index('managed_site_subscription_intents_owner_status_idx').on(table.ownerUserId, table.status),
])

export type ManagedSitePreview = typeof managedSitePreviews.$inferSelect
export type ManagedSiteQuote = typeof managedSiteQuotes.$inferSelect
export type ManagedSiteQuoteLine = typeof managedSiteQuoteLines.$inferSelect
export type ManagedSiteLeadIntent = typeof managedSiteLeadIntents.$inferSelect
export type ManagedSiteDraftOrder = typeof managedSiteDraftOrders.$inferSelect
export type ManagedSitePaymentEvent = typeof managedSitePaymentEvents.$inferSelect
export type ManagedSiteSubscriptionIntent = typeof managedSiteSubscriptionIntents.$inferSelect


/** Customer domain ownership and purchase intent; provider execution is deliberately separate. */
export const managedSiteDomainIntents = mysqlTable('managedSiteDomainIntents', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  draftOrderId: int('draftOrderId').references(() => managedSiteDraftOrders.id),
  mode: mysqlEnum('mode', ['customer_owned', 'new_registration', 'assisted']).notNull(),
  requestedDomain: varchar('requestedDomain', { length: 253 }).notNull(),
  normalizedDomain: varchar('normalizedDomain', { length: 253 }).notNull(),
  ownershipStatus: mysqlEnum('ownershipStatus', ['unknown', 'customer_confirmed', 'provider_verified', 'needs_customer_action']).default('unknown').notNull(),
  purchaseStatus: mysqlEnum('purchaseStatus', ['not_requested', 'intent_created', 'pending_provider', 'registered', 'failed', 'cancelled']).default('not_requested').notNull(),
  dnsStatus: mysqlEnum('dnsStatus', ['not_requested', 'pending_customer', 'pending_provider', 'verified', 'failed']).default('not_requested').notNull(),
  providerKey: varchar('providerKey', { length: 96 }),
  providerReference: varchar('providerReference', { length: 160 }),
  configurationFingerprint: varchar('configurationFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_domain_intents_project_unique').on(table.projectId),
  uniqueIndex('managed_site_domain_intents_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('managed_site_domain_intents_owner_status_idx').on(table.ownerUserId, table.purchaseStatus, table.dnsStatus),
])

/** Provider-neutral deployment plan. It records intent and receipts, not credentials or generated executable source. */
export const managedSiteProvisioningPlans = mysqlTable('managedSiteProvisioningPlans', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  versionId: int('versionId').notNull().references(() => managedSiteVersions.id),
  domainIntentId: int('domainIntentId').notNull().references(() => managedSiteDomainIntents.id),
  platform: mysqlEnum('platform', ['vercel', 'cloudflare_pages', 'manual_export']).notNull(),
  deploymentMode: mysqlEnum('deploymentMode', ['preview_only', 'customer_authorized', 'owner_authorized']).default('preview_only').notNull(),
  status: mysqlEnum('status', ['draft', 'awaiting_payment', 'awaiting_authorization', 'queued', 'processing', 'retry_wait', 'blocked', 'failed', 'succeeded', 'cancelled']).default('draft').notNull(),
  domainStatus: mysqlEnum('domainStatus', ['not_started', 'awaiting_customer', 'provider_pending', 'verified', 'blocked']).default('not_started').notNull(),
  dnsStatus: mysqlEnum('dnsStatus', ['not_started', 'awaiting_customer', 'provider_pending', 'verified', 'blocked']).default('not_started').notNull(),
  tlsStatus: mysqlEnum('tlsStatus', ['not_started', 'provider_pending', 'verified', 'blocked']).default('not_started').notNull(),
  deploymentStatus: mysqlEnum('deploymentStatus', ['not_started', 'provider_pending', 'built', 'released', 'blocked', 'failed']).default('not_started').notNull(),
  intentFingerprint: varchar('intentFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  providerProjectReference: varchar('providerProjectReference', { length: 160 }),
  providerDeploymentReference: varchar('providerDeploymentReference', { length: 160 }),
  deployedUrl: varchar('deployedUrl', { length: 2048 }),
  tlsCertificateReference: varchar('tlsCertificateReference', { length: 160 }),
  leaseOwner: varchar('leaseOwner', { length: 128 }),
  leaseExpiresAt: timestamp('leaseExpiresAt'),
  retryEligibleAt: timestamp('retryEligibleAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_provisioning_plans_project_version_unique').on(table.projectId, table.versionId),
  uniqueIndex('managed_site_provisioning_plans_owner_intent_unique').on(table.ownerUserId, table.intentFingerprint),
  uniqueIndex('managed_site_provisioning_plans_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  index('managed_site_provisioning_plans_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
])

/** Ordered, retryable, provider-neutral provisioning steps. */
export const managedSiteProvisioningSteps = mysqlTable('managedSiteProvisioningSteps', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  planId: int('planId').notNull().references(() => managedSiteProvisioningPlans.id),
  stepKey: varchar('stepKey', { length: 96 }).notNull(),
  ordinal: int('ordinal').notNull(),
  status: mysqlEnum('status', ['pending', 'awaiting_customer', 'blocked', 'processing', 'retry_wait', 'succeeded', 'failed', 'cancelled']).default('pending').notNull(),
  providerKey: varchar('providerKey', { length: 96 }),
  attemptNumber: int('attemptNumber').default(0).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  outputFingerprint: varchar('outputFingerprint', { length: 128 }),
  errorCode: varchar('errorCode', { length: 120 }),
  errorSummary: varchar('errorSummary', { length: 500 }),
  externalReference: varchar('externalReference', { length: 160 }),
  completedAt: timestamp('completedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_provisioning_steps_plan_key_unique').on(table.planId, table.stepKey),
  index('managed_site_provisioning_steps_owner_plan_status_idx').on(table.ownerUserId, table.planId, table.status),
])

/** Append-only provisioning receipts; external provider calls are never implied by an intent record. */
export const managedSiteProvisioningEvents = mysqlTable('managedSiteProvisioningEvents', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  planId: int('planId').notNull().references(() => managedSiteProvisioningPlans.id),
  stepId: int('stepId').references(() => managedSiteProvisioningSteps.id),
  eventType: varchar('eventType', { length: 120 }).notNull(),
  executionMode: mysqlEnum('executionMode', ['dry_run', 'mocked', 'external']).notNull(),
  status: mysqlEnum('status', ['planned', 'blocked', 'succeeded', 'failed']).notNull(),
  providerKey: varchar('providerKey', { length: 96 }),
  externalReference: varchar('externalReference', { length: 160 }),
  receiptFingerprint: varchar('receiptFingerprint', { length: 128 }).notNull(),
  metadata: json('metadata').notNull(),
  occurredAt: timestamp('occurredAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_provisioning_events_receipt_unique').on(table.ownerUserId, table.receiptFingerprint),
  index('managed_site_provisioning_events_owner_plan_idx').on(table.ownerUserId, table.planId, table.occurredAt),
])

export type ManagedSiteDomainIntent = typeof managedSiteDomainIntents.$inferSelect
export type ManagedSiteProvisioningPlan = typeof managedSiteProvisioningPlans.$inferSelect
export type ManagedSiteProvisioningStep = typeof managedSiteProvisioningSteps.$inferSelect
export type ManagedSiteProvisioningEvent = typeof managedSiteProvisioningEvents.$inferSelect


/** Server-only registry for managed-site connector capabilities. Only opaque credential references are stored. */
export const managedSiteProviderConfigurations = mysqlTable('managedSiteProviderConfigurations', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  capability: mysqlEnum('capability', ['website_generator', 'payment', 'domain_registration', 'dns_tls', 'deployment']).notNull(),
  providerKey: varchar('providerKey', { length: 96 }).notNull(),
  readinessStatus: mysqlEnum('readinessStatus', ['disabled', 'mock', 'configured', 'verified', 'blocked']).default('disabled').notNull(),
  credentialReference: varchar('credentialReference', { length: 160 }),
  transportConfiguration: json('transportConfiguration').notNull(),
  configurationFingerprint: varchar('configurationFingerprint', { length: 128 }).notNull(),
  verificationReceiptFingerprint: varchar('verificationReceiptFingerprint', { length: 128 }),
  capabilityIdentity: varchar('capabilityIdentity', { length: 160 }),
  blockedReasonCode: varchar('blockedReasonCode', { length: 120 }),
  verifiedAt: timestamp('verifiedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_provider_config_owner_capability_unique').on(table.ownerUserId, table.capability),
  uniqueIndex('managed_site_provider_config_owner_fingerprint_unique').on(table.ownerUserId, table.configurationFingerprint),
  index('managed_site_provider_config_owner_status_idx').on(table.ownerUserId, table.readinessStatus),
])

/** Exact owner-claimed commercial lineage established before any provider generation or checkout session. */
export const managedSitePrePurchaseBindings = mysqlTable('managedSitePrePurchaseBindings', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  sourceVersionId: int('sourceVersionId').notNull().references(() => managedSiteVersions.id),
  previewId: int('previewId').notNull().references(() => managedSitePreviews.id),
  quoteId: int('quoteId').notNull().references(() => managedSiteQuotes.id),
  draftOrderId: int('draftOrderId').notNull().references(() => managedSiteDraftOrders.id),
  commerceSnapshotFingerprint: varchar('commerceSnapshotFingerprint', { length: 128 }).notNull(),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_prepurchase_project_unique').on(table.projectId),
  uniqueIndex('managed_site_prepurchase_order_unique').on(table.draftOrderId),
  uniqueIndex('managed_site_prepurchase_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('managed_site_prepurchase_owner_request_unique').on(table.ownerUserId, table.requestFingerprint),
  index('managed_site_prepurchase_owner_lineage_idx').on(table.ownerUserId, table.previewId, table.quoteId, table.draftOrderId),
])

/** Immutable admitted generator output. Source bytes remain in the owner vault behind an opaque reference. */
export const managedSiteGenerationCandidates = mysqlTable('managedSiteGenerationCandidates', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  sourceVersionId: int('sourceVersionId').notNull().references(() => managedSiteVersions.id),
  requestSchemaVersion: varchar('requestSchemaVersion', { length: 96 }).notNull(),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  providerKey: varchar('providerKey', { length: 96 }).notNull(),
  providerModel: varchar('providerModel', { length: 128 }).notNull(),
  providerRequestId: varchar('providerRequestId', { length: 160 }).notNull(),
  manifest: json('manifest').notNull(),
  manifestHash: varchar('manifestHash', { length: 128 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  vaultReference: varchar('vaultReference', { length: 512 }).notNull(),
  gateSummary: json('gateSummary').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_generation_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('managed_site_generation_owner_request_unique').on(table.ownerUserId, table.requestFingerprint),
  uniqueIndex('managed_site_generation_provider_request_unique').on(table.providerKey, table.providerRequestId),
  index('managed_site_generation_owner_project_idx').on(table.ownerUserId, table.projectId, table.createdAt),
])

/** Mutable projection for one immutable candidate moving through preview approval, release, and rollback. */
export const managedSiteReleaseProjections = mysqlTable('managedSiteReleaseProjections', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  generationCandidateId: int('generationCandidateId').references(() => managedSiteGenerationCandidates.id),
  versionId: int('versionId').notNull().references(() => managedSiteVersions.id),
  previewId: int('previewId').references(() => managedSitePreviews.id),
  quoteId: int('quoteId').references(() => managedSiteQuotes.id),
  draftOrderId: int('draftOrderId').references(() => managedSiteDraftOrders.id),
  commerceSnapshotFingerprint: varchar('commerceSnapshotFingerprint', { length: 128 }),
  releaseKind: mysqlEnum('releaseKind', ['generated_site', 'existing_site']).notNull(),
  targetKey: varchar('targetKey', { length: 120 }).notNull(),
  canonicalDomain: varchar('canonicalDomain', { length: 253 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['candidate', 'preview_pending', 'preview_ready', 'approved', 'checkout_pending', 'payment_verified', 'provisioning', 'deployment_pending', 'rollback_pending', 'live_verified', 'geo_active', 'retry_wait', 'blocked', 'failed', 'rolled_back']).default('candidate').notNull(),
  previewUrl: varchar('previewUrl', { length: 2048 }),
  providerPreviewId: varchar('providerPreviewId', { length: 160 }),
  approvalFingerprint: varchar('approvalFingerprint', { length: 128 }),
  approvedAt: timestamp('approvedAt'),
  activeDeploymentReceiptFingerprint: varchar('activeDeploymentReceiptFingerprint', { length: 128 }),
  rollbackFromReleaseId: int('rollbackFromReleaseId'),
  blockedReasonCode: varchar('blockedReasonCode', { length: 120 }),
  nextSafeAction: varchar('nextSafeAction', { length: 120 }).notNull(),
  projectionFingerprint: varchar('projectionFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_release_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('managed_site_release_project_target_content_unique').on(table.projectId, table.targetKey, table.contentHash),
  index('managed_site_release_owner_project_status_idx').on(table.ownerUserId, table.projectId, table.status),
  index('managed_site_release_commerce_lineage_idx').on(table.ownerUserId, table.previewId, table.quoteId, table.draftOrderId),
])

/** Signature-verified webhook inbox. Raw bodies and authorization material are never stored. */
export const managedSitePaymentWebhookInbox = mysqlTable('managedSitePaymentWebhookInbox', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').references(() => users.id),
  projectId: int('projectId').references(() => managedSiteProjects.id),
  releaseId: int('releaseId').references(() => managedSiteReleaseProjections.id),
  draftOrderId: int('draftOrderId').notNull().references(() => managedSiteDraftOrders.id),
  providerKey: varchar('providerKey', { length: 96 }).notNull(),
  providerEventId: varchar('providerEventId', { length: 160 }).notNull(),
  eventType: varchar('eventType', { length: 96 }).notNull(),
  canonicalPayloadHash: varchar('canonicalPayloadHash', { length: 128 }).notNull(),
  exactResponseIdentity: varchar('exactResponseIdentity', { length: 256 }).notNull(),
  eventFingerprint: varchar('eventFingerprint', { length: 128 }).notNull(),
  processingStatus: mysqlEnum('processingStatus', ['processing', 'succeeded', 'ignored', 'blocked']).default('processing').notNull(),
  processingFingerprint: varchar('processingFingerprint', { length: 128 }).notNull(),
  receivedAt: timestamp('receivedAt').defaultNow().notNull(),
  completedAt: timestamp('completedAt'),
}, table => [
  uniqueIndex('managed_site_payment_inbox_provider_event_unique').on(table.providerKey, table.providerEventId),
  uniqueIndex('managed_site_payment_inbox_event_fingerprint_unique').on(table.eventFingerprint),
  index('managed_site_payment_inbox_order_status_idx').on(table.draftOrderId, table.processingStatus),
])

export type ManagedSitePaymentWebhookInbox = typeof managedSitePaymentWebhookInbox.$inferSelect

/** Append-only, content-bound gate observations. A preview transport receipt is never a substitute for these results. */
export const managedSiteGateResults = mysqlTable('managedSiteGateResults', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  versionId: int('versionId').notNull().references(() => managedSiteVersions.id),
  generationCandidateId: int('generationCandidateId').notNull().references(() => managedSiteGenerationCandidates.id),
  releaseId: int('releaseId').notNull().references(() => managedSiteReleaseProjections.id),
  gateType: mysqlEnum('gateType', ['artifact_admission', 'deterministic_compiler', 'preview_build', 'security_static_active_content', 'geo_content_structure', 'human_review']).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  result: mysqlEnum('result', ['passed', 'failed', 'required']).notNull(),
  reasonCodes: json('reasonCodes').notNull(),
  limitations: json('limitations').notNull(),
  receiptFingerprint: varchar('receiptFingerprint', { length: 128 }).notNull(),
  observedAt: timestamp('observedAt').notNull(),
}, table => [
  uniqueIndex('managed_site_gate_release_type_input_unique').on(table.releaseId, table.gateType, table.inputFingerprint),
  uniqueIndex('managed_site_gate_owner_receipt_unique').on(table.ownerUserId, table.receiptFingerprint),
  index('managed_site_gate_owner_release_result_idx').on(table.ownerUserId, table.releaseId, table.result),
])

/** Global atomic authority claim for a canonical domain. Release is explicit; no workflow silently frees a claim. */
export const managedSiteDomainClaims = mysqlTable('managedSiteDomainClaims', {
  id: int('id').autoincrement().primaryKey(),
  canonicalDomain: varchar('canonicalDomain', { length: 253 }).notNull(),
  activeCanonicalDomainKey: varchar('activeCanonicalDomainKey', { length: 253 }).generatedAlwaysAs(sql`CASE WHEN \`status\` = 'released' THEN NULL ELSE \`canonicalDomain\` END`, { mode: 'stored' }),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  releaseId: int('releaseId').notNull().references(() => managedSiteReleaseProjections.id),
  claimKind: mysqlEnum('claimKind', ['generated', 'existing']).notNull(),
  status: mysqlEnum('status', ['pending', 'verified', 'released', 'blocked']).default('pending').notNull(),
  authorityReceiptFingerprint: varchar('authorityReceiptFingerprint', { length: 128 }),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  projectionFingerprint: varchar('projectionFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_domain_claim_active_canonical_unique').on(table.activeCanonicalDomainKey),
  uniqueIndex('managed_site_domain_claim_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('managed_site_domain_claim_release_unique').on(table.releaseId),
  index('managed_site_domain_claim_owner_project_status_idx').on(table.ownerUserId, table.projectId, table.status),
])

/** Leased, bounded connector attempts. Error fields are redacted summaries only. */
export const managedSiteConnectorAttempts = mysqlTable('managedSiteConnectorAttempts', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').references(() => managedSiteProjects.id),
  draftOrderId: int('draftOrderId').references(() => managedSiteDraftOrders.id),
  releaseId: int('releaseId').references(() => managedSiteReleaseProjections.id),
  capability: mysqlEnum('capability', ['website_generator', 'payment', 'domain_registration', 'dns_tls', 'deployment']).notNull(),
  operation: varchar('operation', { length: 120 }).notNull(),
  executionMode: mysqlEnum('executionMode', ['dry_run', 'mocked', 'live']).notNull(),
  status: mysqlEnum('status', ['queued', 'processing', 'retry_wait', 'blocked', 'failed', 'succeeded']).default('queued').notNull(),
  attemptNumber: int('attemptNumber').default(0).notNull(),
  maxAttempts: int('maxAttempts').default(3).notNull(),
  timeoutMs: int('timeoutMs').notNull(),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  leaseOwner: varchar('leaseOwner', { length: 128 }),
  leaseExpiresAt: timestamp('leaseExpiresAt'),
  retryEligibleAt: timestamp('retryEligibleAt'),
  exactResponseIdentity: varchar('exactResponseIdentity', { length: 256 }),
  errorCode: varchar('errorCode', { length: 120 }),
  errorSummary: varchar('errorSummary', { length: 500 }),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_connector_attempt_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('managed_site_connector_attempt_owner_request_unique').on(table.ownerUserId, table.requestFingerprint),
  index('managed_site_connector_attempt_owner_project_status_idx').on(table.ownerUserId, table.projectId, table.status),
  index('managed_site_connector_attempt_owner_order_idx').on(table.ownerUserId, table.draftOrderId, table.status),
])

/** Append-only verified provider receipts. Raw payloads and credentials are never retained. */
export const managedSiteConnectorReceipts = mysqlTable('managedSiteConnectorReceipts', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').references(() => managedSiteProjects.id),
  draftOrderId: int('draftOrderId').references(() => managedSiteDraftOrders.id),
  releaseId: int('releaseId').references(() => managedSiteReleaseProjections.id),
  attemptId: int('attemptId').references(() => managedSiteConnectorAttempts.id),
  capability: mysqlEnum('capability', ['website_generator', 'payment', 'domain_registration', 'dns_tls', 'deployment']).notNull(),
  providerKey: varchar('providerKey', { length: 96 }).notNull(),
  providerEventId: varchar('providerEventId', { length: 160 }).notNull(),
  receiptType: varchar('receiptType', { length: 120 }).notNull(),
  receiptStatus: mysqlEnum('receiptStatus', ['verified', 'ignored_out_of_order', 'replayed', 'rejected']).notNull(),
  externalReference: varchar('externalReference', { length: 160 }),
  exactResponseIdentity: varchar('exactResponseIdentity', { length: 256 }).notNull(),
  requestFingerprint: varchar('requestFingerprint', { length: 128 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }),
  canonicalDomain: varchar('canonicalDomain', { length: 253 }),
  metadata: json('metadata').notNull(),
  receiptFingerprint: varchar('receiptFingerprint', { length: 128 }).notNull(),
  verifiedAt: timestamp('verifiedAt').notNull(),
}, table => [
  uniqueIndex('managed_site_connector_receipt_provider_event_unique').on(table.providerKey, table.providerEventId),
  uniqueIndex('managed_site_connector_receipt_owner_fingerprint_unique').on(table.ownerUserId, table.receiptFingerprint),
  index('managed_site_connector_receipt_owner_project_idx').on(table.ownerUserId, table.projectId, table.verifiedAt),
  index('managed_site_connector_receipt_owner_order_idx').on(table.ownerUserId, table.draftOrderId, table.verifiedAt),
])

export type ManagedSiteProviderConfiguration = typeof managedSiteProviderConfigurations.$inferSelect
export type ManagedSitePrePurchaseBinding = typeof managedSitePrePurchaseBindings.$inferSelect
export type ManagedSiteGenerationCandidate = typeof managedSiteGenerationCandidates.$inferSelect
export type ManagedSiteReleaseProjection = typeof managedSiteReleaseProjections.$inferSelect
export type ManagedSiteGateResult = typeof managedSiteGateResults.$inferSelect
export type ManagedSiteDomainClaim = typeof managedSiteDomainClaims.$inferSelect
export type ManagedSiteConnectorAttempt = typeof managedSiteConnectorAttempts.$inferSelect
export type ManagedSiteConnectorReceipt = typeof managedSiteConnectorReceipts.$inferSelect


/** Provider-neutral module integration intent. Tokens, secrets, and external writes are intentionally excluded. */
export const managedSiteIntegrations = mysqlTable('managedSiteIntegrations', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  moduleKey: mysqlEnum('moduleKey', ['bounded_ai_assistant', 'shopify_commerce', 'line_assisted_integration', 'google_booking_assisted_integration', 'payment', 'invoice', 'membership', 'pwa_reference_only']).notNull(),
  providerKey: varchar('providerKey', { length: 96 }).notNull(),
  status: mysqlEnum('status', ['not_configured', 'awaiting_authorization', 'mock_verified', 'active', 'blocked', 'revoked']).default('not_configured').notNull(),
  authorizationMode: mysqlEnum('authorizationMode', ['none', 'customer_oauth', 'customer_api_key', 'owner_configured', 'manual_assistance']).notNull(),
  requiredScopes: json('requiredScopes').notNull(),
  redactedConfig: json('redactedConfig').notNull(),
  shopDomain: varchar('shopDomain', { length: 253 }),
  intentFingerprint: varchar('intentFingerprint', { length: 128 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  externalReference: varchar('externalReference', { length: 160 }),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('managed_site_integrations_project_module_unique').on(table.projectId, table.moduleKey),
  uniqueIndex('managed_site_integrations_owner_intent_unique').on(table.ownerUserId, table.intentFingerprint),
  uniqueIndex('managed_site_integrations_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('managed_site_integrations_owner_shop_domain_unique').on(table.ownerUserId, table.shopDomain),
  index('managed_site_integrations_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
])

export type ManagedSiteIntegration = typeof managedSiteIntegrations.$inferSelect

/** Shopify OAuth state ledger; only state is used by the official V1 authorization-code flow. Legacy nonce/PKCE hashes remain nullable for compatibility. */
export const managedSiteShopifyAuthorizations = mysqlTable('managedSiteShopifyAuthorizations', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  integrationId: int('integrationId').notNull().references(() => managedSiteIntegrations.id),
  stateHash: varchar('stateHash', { length: 128 }).notNull(),
  nonceHash: varchar('nonceHash', { length: 128 }),
  codeVerifierHash: varchar('codeVerifierHash', { length: 128 }),
  shopDomain: varchar('shopDomain', { length: 253 }).notNull(),
  redirectUri: varchar('redirectUri', { length: 2048 }).notNull(),
  status: mysqlEnum('status', ['pending', 'consumed', 'expired', 'revoked']).default('pending').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  consumedAt: timestamp('consumedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_shopify_authorizations_state_unique').on(table.stateHash),
  index('managed_site_shopify_authorizations_owner_project_status_idx').on(table.ownerUserId, table.projectId, table.status, table.expiresAt),
])

/** Shopify webhook replay ledger; payload bodies and secrets are never persisted. */
export const managedSiteShopifyWebhooks = mysqlTable('managedSiteShopifyWebhooks', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId').notNull().references(() => managedSiteProjects.id),
  integrationId: int('integrationId').notNull().references(() => managedSiteIntegrations.id),
  shopDomain: varchar('shopDomain', { length: 253 }).notNull(),
  webhookId: varchar('webhookId', { length: 160 }).notNull(),
  topic: varchar('topic', { length: 160 }).notNull(),
  payloadHash: varchar('payloadHash', { length: 128 }).notNull(),
  signatureHash: varchar('signatureHash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['accepted', 'replayed', 'rejected']).notNull(),
  eventFingerprint: varchar('eventFingerprint', { length: 128 }).notNull(),
  receivedAt: timestamp('receivedAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('managed_site_shopify_webhooks_integration_event_unique').on(table.integrationId, table.webhookId),
  uniqueIndex('managed_site_shopify_webhooks_fingerprint_unique').on(table.ownerUserId, table.eventFingerprint),
  index('managed_site_shopify_webhooks_owner_project_idx').on(table.ownerUserId, table.projectId, table.receivedAt),
])

export type ManagedSiteShopifyAuthorization = typeof managedSiteShopifyAuthorizations.$inferSelect
export type ManagedSiteShopifyWebhook = typeof managedSiteShopifyWebhooks.$inferSelect

/** GEO outcome observation runs: metadata only; raw provider responses and credentials are never stored. */
export const geoOutcomeObservationRuns = mysqlTable('geoOutcomeObservationRuns', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  projectId: int('projectId'),
  clientId: varchar('clientId', { length: 128 }),
  runIdentity: varchar('runIdentity', { length: 160 }).notNull(),
  engine: varchar('engine', { length: 96 }).notNull(),
  model: varchar('model', { length: 160 }).notNull(),
  modelVersion: varchar('modelVersion', { length: 160 }),
  interface: varchar('interface', { length: 96 }).notNull(),
  locale: varchar('locale', { length: 32 }).notNull(),
  region: varchar('region', { length: 64 }),
  observationWindowStart: timestamp('observationWindowStart').notNull(),
  observationWindowEnd: timestamp('observationWindowEnd').notNull(),
  runTimestamp: timestamp('runTimestamp').notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  status: mysqlEnum('status', ['received', 'verified', 'stale', 'revoked']).default('received').notNull(),
  runFingerprint: varchar('runFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_runs_owner_identity_unique').on(table.ownerUserId, table.runIdentity),
  uniqueIndex('geo_outcome_runs_fingerprint_unique').on(table.ownerUserId, table.runFingerprint),
  index('geo_outcome_runs_owner_time_idx').on(table.ownerUserId, table.runTimestamp),
])

/** GEO outcome candidates: de-identified hashes and normalized contract fields only. */
export const geoOutcomeObservationCandidates = mysqlTable('geoOutcomeObservationCandidates', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  observationRunId: int('observationRunId').notNull().references(() => geoOutcomeObservationRuns.id),
  websiteIdentityHash: varchar('websiteIdentityHash', { length: 128 }).notNull(),
  queryIdentityHash: varchar('queryIdentityHash', { length: 128 }).notNull(),
  normalizedQueryHash: varchar('normalizedQueryHash', { length: 128 }).notNull(),
  candidatePageIdentityHash: varchar('candidatePageIdentityHash', { length: 128 }).notNull(),
  canonicalPageHash: varchar('canonicalPageHash', { length: 128 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  evidenceSnapshotHash: varchar('evidenceSnapshotHash', { length: 128 }).notNull(),
  publicationReceiptFingerprint: varchar('publicationReceiptFingerprint', { length: 128 }),
  observableStatus: varchar('observableStatus', { length: 48 }).notNull(),
  retrievalStatus: varchar('retrievalStatus', { length: 48 }).notNull(),
  citationStatus: varchar('citationStatus', { length: 48 }).notNull(),
  citationPosition: int('citationPosition'),
  mentionStatus: varchar('mentionStatus', { length: 48 }).notNull(),
  recommendationStatus: varchar('recommendationStatus', { length: 48 }).notNull(),
  labelBasis: varchar('labelBasis', { length: 96 }).notNull(),
  verificationStatus: varchar('verificationStatus', { length: 48 }).notNull(),
  consentStatus: mysqlEnum('consentStatus', ['approved', 'revoked', 'unknown']).default('unknown').notNull(),
  piiStatus: mysqlEnum('piiStatus', ['clean', 'contains_pii', 'unknown']).default('unknown').notNull(),
  verificationAuthority: varchar('verificationAuthority', { length: 96 }).default('none').notNull(),
  intakeFingerprint: varchar('intakeFingerprint', { length: 128 }).notNull(),
  reviewFingerprint: varchar('reviewFingerprint', { length: 128 }),
  observationPayload: json('observationPayload').notNull(),
  evidenceLocatorHashes: json('evidenceLocatorHashes').notNull(),
  appliedRuleHashes: json('appliedRuleHashes').notNull(),
  contentFeatureVector: json('contentFeatureVector').notNull(),
  observationFingerprint: varchar('observationFingerprint', { length: 128 }).notNull(),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_candidates_owner_identity_unique').on(table.ownerUserId, table.observationRunId, table.candidatePageIdentityHash),
  uniqueIndex('geo_outcome_candidates_fingerprint_unique').on(table.ownerUserId, table.observationFingerprint),
  index('geo_outcome_candidates_owner_query_idx').on(table.ownerUserId, table.normalizedQueryHash, table.observationRunId),
])

export const geoOutcomeDatasetManifests = mysqlTable('geoOutcomeDatasetManifests', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  manifestId: varchar('manifestId', { length: 160 }).notNull(),
  schemaVersion: varchar('schemaVersion', { length: 96 }).notNull(),
  taskType: mysqlEnum('taskType', ['citation_selection', 'structural_readiness_auxiliary']).notNull(),
  featureCatalogVersion: varchar('featureCatalogVersion', { length: 128 }).notNull(),
  labelContractVersion: varchar('labelContractVersion', { length: 128 }).notNull(),
  hardNegativePolicyVersion: varchar('hardNegativePolicyVersion', { length: 128 }).notNull(),
  sourceObservationFingerprints: json('sourceObservationFingerprints').notNull(),
  sourceBasisCounts: json('sourceBasisCounts').notNull(),
  engineCounts: json('engineCounts').notNull(),
  localeCounts: json('localeCounts').notNull(),
  websiteCount: int('websiteCount').notNull(),
  queryGroupCount: int('queryGroupCount').notNull(),
  positiveCount: int('positiveCount').notNull(),
  hardNegativeCount: int('hardNegativeCount').notNull(),
  observationStart: timestamp('observationStart'),
  observationEnd: timestamp('observationEnd'),
  splitPolicyVersion: varchar('splitPolicyVersion', { length: 128 }).notNull(),
  splitFingerprints: json('splitFingerprints').notNull(),
  manifestFingerprint: varchar('manifestFingerprint', { length: 128 }).notNull(),
  limitations: json('limitations').notNull(),
  readiness: json('readiness').notNull(),
  status: mysqlEnum('status', ['draft', 'gate_blocked', 'ready_for_review', 'approved', 'revoked', 'archived']).default('draft').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_datasets_owner_manifest_unique').on(table.ownerUserId, table.manifestId),
  uniqueIndex('geo_outcome_datasets_fingerprint_unique').on(table.ownerUserId, table.manifestFingerprint),
  index('geo_outcome_datasets_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
])

export const geoOutcomeDatasetMembers = mysqlTable('geoOutcomeDatasetMembers', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  datasetManifestId: int('datasetManifestId').notNull().references(() => geoOutcomeDatasetManifests.id),
  observationFingerprint: varchar('observationFingerprint', { length: 128 }).notNull(),
  websiteIdentityHash: varchar('websiteIdentityHash', { length: 128 }).notNull(),
  normalizedQueryHash: varchar('normalizedQueryHash', { length: 128 }).notNull(),
  runIdentity: varchar('runIdentity', { length: 160 }).notNull(),
  queryGroupKey: varchar('queryGroupKey', { length: 128 }).notNull(),
  label: mysqlEnum('label', ['positive', 'hard_negative']).notNull(),
  splitAssignment: mysqlEnum('splitAssignment', ['train', 'validation', 'test', 'site_holdout', 'query_holdout', 'temporal_holdout']).notNull(),
  consentStatus: mysqlEnum('consentStatus', ['approved', 'revoked', 'unknown']).default('unknown').notNull(),
  piiStatus: mysqlEnum('piiStatus', ['clean', 'contains_pii', 'unknown']).default('unknown').notNull(),
  reviewFingerprint: varchar('reviewFingerprint', { length: 128 }),
  featureVector: json('featureVector').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_members_manifest_observation_unique').on(table.datasetManifestId, table.observationFingerprint),
  index('geo_outcome_members_owner_query_idx').on(table.ownerUserId, table.normalizedQueryHash),
])

/** Append-only owner dataset decision ledger; the manifest row is only a current projection. */
export const geoOutcomeDatasetDecisions = mysqlTable('geoOutcomeDatasetDecisions', {
  id: int('id').autoincrement().primaryKey(),
  decisionId: varchar('decisionId', { length: 160 }).notNull().unique(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  datasetManifestId: int('datasetManifestId').notNull().references(() => geoOutcomeDatasetManifests.id),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  previousStatus: varchar('previousStatus', { length: 96 }).notNull(),
  newStatus: varchar('newStatus', { length: 96 }).notNull(),
  reason: varchar('reason', { length: 500 }).notNull(),
  manifestFingerprint: varchar('manifestFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  index('geo_outcome_dataset_decisions_owner_manifest_idx').on(table.ownerUserId, table.datasetManifestId, table.createdAt),
])

export const geoOutcomeTrainingRuns = mysqlTable('geoOutcomeTrainingRuns', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  trainingRunId: varchar('trainingRunId', { length: 160 }).notNull(),
  datasetManifestId: int('datasetManifestId').notNull().references(() => geoOutcomeDatasetManifests.id),
  modelFamily: mysqlEnum('modelFamily', ['regularized_logistic_baseline_v1', 'pairwise_logistic_ranker_v1']).notNull(),
  status: mysqlEnum('status', ['queued', 'running', 'completed', 'blocked', 'failed']).default('queued').notNull(),
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
  leaseOwner: varchar('leaseOwner', { length: 128 }),
  leaseExpiresAt: timestamp('leaseExpiresAt'),
  version: int('version').default(0).notNull(),
  configuration: json('configuration').notNull(),
  artifactId: varchar('artifactId', { length: 160 }),
  artifactHash: varchar('artifactHash', { length: 128 }),
  metrics: json('metrics'),
  reason: varchar('reason', { length: 500 }),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_training_owner_id_unique').on(table.ownerUserId, table.trainingRunId),
  index('geo_outcome_training_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
])

export const geoOutcomeModelArtifacts = mysqlTable('geoOutcomeModelArtifacts', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  artifactId: varchar('artifactId', { length: 160 }).notNull(),
  artifactSchemaVersion: varchar('artifactSchemaVersion', { length: 128 }).notNull(),
  taskType: mysqlEnum('taskType', ['citation_selection', 'structural_readiness_auxiliary']).notNull(),
  modelFamily: mysqlEnum('modelFamily', ['regularized_logistic_baseline_v1', 'pairwise_logistic_ranker_v1']).notNull(),
  modelVersion: varchar('modelVersion', { length: 128 }).notNull(),
  featureCatalogVersion: varchar('featureCatalogVersion', { length: 128 }).notNull(),
  labelContractVersion: varchar('labelContractVersion', { length: 128 }).notNull(),
  datasetManifestFingerprint: varchar('datasetManifestFingerprint', { length: 128 }).notNull(),
  splitManifestFingerprint: varchar('splitManifestFingerprint', { length: 128 }).notNull(),
  coefficients: json('coefficients').notNull(),
  intercept: decimal('intercept', { precision: 24, scale: 12 }).notNull(),
  normalizationStatistics: json('normalizationStatistics').notNull(),
  trainingConfiguration: json('trainingConfiguration').notNull(),
  trainingRowCount: int('trainingRowCount').notNull(),
  evaluationMetrics: json('evaluationMetrics').notNull(),
  limitations: json('limitations').notNull(),
  artifactFingerprint: varchar('artifactFingerprint', { length: 128 }).notNull(),
  artifactHash: varchar('artifactHash', { length: 128 }).notNull(),
  rollbackArtifactHash: varchar('rollbackArtifactHash', { length: 128 }),
  status: mysqlEnum('status', ['development', 'evaluation_failed', 'ready_for_owner_review', 'approved_for_shadow', 'shadow_failed', 'revoked', 'archived']).default('development').notNull(),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_artifacts_owner_id_unique').on(table.ownerUserId, table.artifactId),
  uniqueIndex('geo_outcome_artifacts_hash_unique').on(table.ownerUserId, table.artifactHash),
  index('geo_outcome_artifacts_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
])

/** Append-only owner decision ledger; application code intentionally exposes no update/delete operation. */
export const geoOutcomeModelDecisions = mysqlTable('geoOutcomeModelDecisions', {
  id: int('id').autoincrement().primaryKey(),
  decisionId: varchar('decisionId', { length: 160 }).notNull().unique(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  modelArtifactId: int('modelArtifactId').notNull().references(() => geoOutcomeModelArtifacts.id),
  previousStatus: varchar('previousStatus', { length: 96 }).notNull(),
  newStatus: varchar('newStatus', { length: 96 }).notNull(),
  reviewerUserId: int('reviewerUserId').references(() => users.id),
  reason: varchar('reason', { length: 500 }).notNull(),
  artifactHash: varchar('artifactHash', { length: 128 }).notNull(),
  datasetManifestHash: varchar('datasetManifestHash', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  index('geo_outcome_decisions_owner_artifact_idx').on(table.ownerUserId, table.modelArtifactId, table.createdAt),
])

export type GeoOutcomeObservationRun = typeof geoOutcomeObservationRuns.$inferSelect
export type GeoOutcomeObservationCandidate = typeof geoOutcomeObservationCandidates.$inferSelect
export type GeoOutcomeDatasetManifest = typeof geoOutcomeDatasetManifests.$inferSelect
export type GeoOutcomeDatasetMember = typeof geoOutcomeDatasetMembers.$inferSelect
export type GeoOutcomeDatasetDecision = typeof geoOutcomeDatasetDecisions.$inferSelect
export type GeoOutcomeTrainingRun = typeof geoOutcomeTrainingRuns.$inferSelect
export type GeoOutcomeModelArtifact = typeof geoOutcomeModelArtifacts.$inferSelect
export type GeoOutcomeModelDecision = typeof geoOutcomeModelDecisions.$inferSelect

/** Durable mutation authority; unique owner/route/key claims prevent concurrent duplicate execution. */
export const geoOutcomeIdempotencyClaims = mysqlTable('geoOutcomeIdempotencyClaims', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  routeIdentity: varchar('routeIdentity', { length: 160 }).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  state: mysqlEnum('state', ['claimed', 'completed', 'failed']).default('claimed').notNull(),
  responseProjection: json('responseProjection'),
  responseFingerprint: varchar('responseFingerprint', { length: 128 }),
  leaseOwner: varchar('leaseOwner', { length: 128 }),
  leaseExpiresAt: timestamp('leaseExpiresAt'),
  version: int('version').default(0).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  completedAt: timestamp('completedAt'),
}, table => [
  uniqueIndex('geo_outcome_idempotency_owner_route_key_unique').on(table.ownerUserId, table.routeIdentity, table.idempotencyKey),
  index('geo_outcome_idempotency_lease_idx').on(table.state, table.leaseExpiresAt),
])

/** Append-only verification authority ledger; intake cannot self-assert verified primary truth. */
export const geoOutcomeObservationVerifications = mysqlTable('geoOutcomeObservationVerifications', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  observationFingerprint: varchar('observationFingerprint', { length: 128 }).notNull(),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  previousVerificationStatus: varchar('previousVerificationStatus', { length: 48 }).notNull(),
  newVerificationStatus: varchar('newVerificationStatus', { length: 48 }).notNull(),
  evidenceLocatorHash: varchar('evidenceLocatorHash', { length: 128 }),
  factType: mysqlEnum('factType', ['evidence_verification', 'consent_review', 'pii_review', 'revocation']).notNull(),
  factStatus: mysqlEnum('factStatus', ['approved', 'rejected', 'revoked']).notNull(),
  reason: varchar('reason', { length: 500 }).notNull(),
  decisionFingerprint: varchar('decisionFingerprint', { length: 128 }).notNull(),
  consentStatus: mysqlEnum('consentStatus', ['approved', 'revoked', 'unknown']).notNull(),
  piiStatus: mysqlEnum('piiStatus', ['clean', 'contains_pii', 'unknown']).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_verification_decision_unique').on(table.ownerUserId, table.decisionFingerprint),
  index('geo_outcome_verification_observation_idx').on(table.ownerUserId, table.observationFingerprint, table.createdAt),
])

/** Append-only owner review of one complete observable candidate set for one LLM source. */
export const geoOutcomeCandidateSetDecisions = mysqlTable('geoOutcomeCandidateSetDecisions', {
  id: int('id').autoincrement().primaryKey(),
  decisionId: varchar('decisionId', { length: 160 }).notNull(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  sourceObservationId: int('sourceObservationId').notNull().references(() => llmVisibilityObservations.id),
  sourceProjectId: int('sourceProjectId').notNull().references(() => llmVisibilityProjects.id),
  sourceQueryId: int('sourceQueryId').notNull().references(() => llmVisibilityQueries.id),
  sourceRunId: int('sourceRunId').notNull().references(() => llmVisibilityRuns.id),
  sourceCitationSetFingerprint: varchar('sourceCitationSetFingerprint', { length: 128 }).notNull(),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  decisionType: mysqlEnum('decisionType', ['approve', 'revoke']).notNull(),
  candidateSetFingerprint: varchar('candidateSetFingerprint', { length: 128 }).notNull(),
  targetCandidateSetFingerprint: varchar('targetCandidateSetFingerprint', { length: 128 }),
  reviewReason: varchar('reviewReason', { length: 500 }).notNull(),
  decisionFingerprint: varchar('decisionFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_candidate_sets_decision_unique').on(table.decisionId),
  uniqueIndex('geo_outcome_candidate_sets_owner_key_unique').on(table.ownerUserId, table.idempotencyKey),
  uniqueIndex('geo_outcome_candidate_sets_owner_source_set_decision_unique').on(table.ownerUserId, table.sourceObservationId, table.candidateSetFingerprint, table.decisionType),
  index('geo_outcome_candidate_sets_source_idx').on(table.ownerUserId, table.sourceObservationId, table.createdAt),
])

/** Immutable candidate members derived by the server from public HTTPS URLs. */
export const geoOutcomeCandidateAuthorities = mysqlTable('geoOutcomeCandidateAuthorities', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  candidateSetDecisionId: int('candidateSetDecisionId').notNull().references(() => geoOutcomeCandidateSetDecisions.id),
  sourceObservationId: int('sourceObservationId').notNull().references(() => llmVisibilityObservations.id),
  projectId: int('projectId').notNull().references(() => llmVisibilityProjects.id),
  queryId: int('queryId').notNull().references(() => llmVisibilityQueries.id),
  runId: int('runId').notNull().references(() => llmVisibilityRuns.id),
  canonicalCandidateUrlHash: varchar('canonicalCandidateUrlHash', { length: 128 }).notNull(),
  canonicalPageHash: varchar('canonicalPageHash', { length: 128 }).notNull(),
  candidatePageIdentityHash: varchar('candidatePageIdentityHash', { length: 128 }).notNull(),
  websiteIdentityHash: varchar('websiteIdentityHash', { length: 128 }).notNull(),
  contentHash: varchar('contentHash', { length: 128 }).notNull(),
  publicationReceiptFingerprint: varchar('publicationReceiptFingerprint', { length: 128 }),
  publicationEvidenceSnapshotHash: varchar('publicationEvidenceSnapshotHash', { length: 128 }),
  authorityBasis: mysqlEnum('authorityBasis', ['manual_owner_attested_v1', 'discovery_stack_publication_receipt_v1']).notNull(),
  observabilityReviewStatus: mysqlEnum('observabilityReviewStatus', ['approved_observable']).notNull(),
  retrievalReviewStatus: mysqlEnum('retrievalReviewStatus', ['approved_retrieved']).notNull(),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  reviewReason: varchar('reviewReason', { length: 500 }).notNull(),
  reviewedAt: timestamp('reviewedAt').notNull(),
  decisionFingerprint: varchar('decisionFingerprint', { length: 128 }).notNull(),
  candidateSetFingerprint: varchar('candidateSetFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_candidate_authority_set_url_unique').on(table.candidateSetDecisionId, table.canonicalCandidateUrlHash),
  uniqueIndex('geo_outcome_candidate_authority_set_identity_unique').on(table.candidateSetDecisionId, table.candidatePageIdentityHash),
  index('geo_outcome_candidate_authority_source_idx').on(table.ownerUserId, table.sourceObservationId, table.candidateSetFingerprint),
])

/** Server-resolved evidence references. Raw content, URLs, tokens and provider payloads are deliberately excluded. */
export const geoOutcomeEvidenceLocators = mysqlTable('geoOutcomeEvidenceLocators', {
  id: int('id').autoincrement().primaryKey(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  observationFingerprint: varchar('observationFingerprint', { length: 128 }).notNull(),
  evidenceLocatorHash: varchar('evidenceLocatorHash', { length: 128 }).notNull(),
  purpose: mysqlEnum('purpose', ['geo_outcome_verification']).notNull(),
  sourceKind: mysqlEnum('sourceKind', ['llm_visibility_observation']).notNull(),
  sourceRecordId: int('sourceRecordId').notNull().references(() => llmVisibilityObservations.id),
  sourceProjectId: int('sourceProjectId').notNull().references(() => llmVisibilityProjects.id),
  sourceQueryId: int('sourceQueryId').notNull().references(() => llmVisibilityQueries.id),
  sourceRunId: int('sourceRunId').notNull().references(() => llmVisibilityRuns.id),
  sourceResponseHash: varchar('sourceResponseHash', { length: 64 }).notNull(),
  sourceCitationSetFingerprint: varchar('sourceCitationSetFingerprint', { length: 128 }).notNull(),
  candidateAuthorityId: int('candidateAuthorityId').notNull().references(() => geoOutcomeCandidateAuthorities.id),
  candidateAuthorityFingerprint: varchar('candidateAuthorityFingerprint', { length: 128 }).notNull(),
  candidateSetFingerprint: varchar('candidateSetFingerprint', { length: 128 }).notNull(),
  canonicalCandidateUrlHash: varchar('canonicalCandidateUrlHash', { length: 128 }).notNull(),
  serverDerivedCitationStatus: mysqlEnum('serverDerivedCitationStatus', ['cited', 'not_cited']).notNull(),
  serverDerivedCitationPosition: int('serverDerivedCitationPosition'),
  evidenceBindingFingerprint: varchar('evidenceBindingFingerprint', { length: 128 }).notNull(),
  sourceObservedAt: timestamp('sourceObservedAt').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_evidence_binding_unique').on(table.ownerUserId, table.observationFingerprint),
  index('geo_outcome_evidence_observation_idx').on(table.ownerUserId, table.observationFingerprint),
])

export type GeoOutcomeIdempotencyClaim = typeof geoOutcomeIdempotencyClaims.$inferSelect
export type GeoOutcomeObservationVerification = typeof geoOutcomeObservationVerifications.$inferSelect
export type GeoOutcomeEvidenceLocator = typeof geoOutcomeEvidenceLocators.$inferSelect

/** Durable owner-scoped automation policy. It never grants dataset/model approval authority. */
export const geoOutcomeModelopsPolicies = mysqlTable('geoOutcomeModelopsPolicies', {
  id: int('id').autoincrement().primaryKey(),
  policyId: varchar('policyId', { length: 160 }).notNull(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  status: mysqlEnum('status', ['enabled', 'paused', 'revoked']).default('paused').notNull(),
  cadence: mysqlEnum('cadence', ['weekly', 'biweekly', 'monthly']).notNull(),
  minimumNewVerifiedCandidates: int('minimumNewVerifiedCandidates').notNull(),
  minimumNewQueryGroups: int('minimumNewQueryGroups').notNull(),
  minimumNewWebsites: int('minimumNewWebsites').notNull(),
  minimumObservationSpanDays: int('minimumObservationSpanDays').notNull(),
  allowedModelFamilies: json('allowedModelFamilies').notNull(),
  maximumTrainingRunsPerCycle: int('maximumTrainingRunsPerCycle').notNull(),
  cooldownHours: int('cooldownHours').notNull(),
  shadowEvaluationEnabled: boolean('shadowEvaluationEnabled').default(true).notNull(),
  authorizedByOwnerUserId: int('authorizedByOwnerUserId').references(() => users.id),
  authorizedAt: timestamp('authorizedAt'),
  expiresAt: timestamp('expiresAt'),
  configurationFingerprint: varchar('configurationFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
  revokedAt: timestamp('revokedAt'),
}, table => [
  uniqueIndex('geo_outcome_modelops_policy_owner_id_unique').on(table.ownerUserId, table.policyId),
  index('geo_outcome_modelops_policy_owner_status_idx').on(table.ownerUserId, table.status, table.updatedAt),
])

/** Durable cycle projection. All values are redacted fingerprints or bounded reason metadata. */
export const geoOutcomeModelopsCycles = mysqlTable('geoOutcomeModelopsCycles', {
  id: int('id').autoincrement().primaryKey(),
  cycleId: varchar('cycleId', { length: 160 }).notNull(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  policyId: varchar('policyId', { length: 160 }).notNull(),
  policyFingerprint: varchar('policyFingerprint', { length: 128 }).notNull(),
  trigger: mysqlEnum('trigger', ['scheduled', 'owner_manual', 'dry_run']).notNull(),
  status: mysqlEnum('status', ['planned', 'running', 'completed', 'blocked', 'insufficient_data', 'failed', 'retry_wait']).default('planned').notNull(),
  readinessSnapshotFingerprint: varchar('readinessSnapshotFingerprint', { length: 128 }).notNull(),
  eligibleObservationFingerprints: json('eligibleObservationFingerprints').notNull(),
  previousApprovedDatasetFingerprint: varchar('previousApprovedDatasetFingerprint', { length: 128 }),
  generatedDatasetFingerprint: varchar('generatedDatasetFingerprint', { length: 128 }),
  trainingRunId: varchar('trainingRunId', { length: 160 }),
  modelArtifactId: varchar('modelArtifactId', { length: 160 }),
  artifactHash: varchar('artifactHash', { length: 128 }),
  shadowEvaluationFingerprint: varchar('shadowEvaluationFingerprint', { length: 128 }),
  reasonCodes: json('reasonCodes').notNull(),
  limitations: json('limitations').notNull(),
  errorClass: varchar('errorClass', { length: 120 }),
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
  attempt: int('attempt').default(0).notNull(),
  leaseOwner: varchar('leaseOwner', { length: 128 }),
  leaseExpiresAt: timestamp('leaseExpiresAt'),
  idempotencyKey: varchar('idempotencyKey', { length: 128 }).notNull(),
  inputFingerprint: varchar('inputFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_modelops_cycle_owner_id_unique').on(table.ownerUserId, table.cycleId),
  uniqueIndex('geo_outcome_modelops_cycle_owner_key_unique').on(table.ownerUserId, table.idempotencyKey),
  index('geo_outcome_modelops_cycle_owner_status_idx').on(table.ownerUserId, table.status, table.createdAt),
  index('geo_outcome_modelops_cycle_lease_idx').on(table.status, table.leaseExpiresAt),
])

/** Append-only ModelOps event ledger. Payloads are bounded redacted projections only. */
export const geoOutcomeModelopsEvents = mysqlTable('geoOutcomeModelopsEvents', {
  id: int('id').autoincrement().primaryKey(),
  eventId: varchar('eventId', { length: 160 }).notNull(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  cycleId: varchar('cycleId', { length: 160 }).notNull(),
  eventType: varchar('eventType', { length: 96 }).notNull(),
  eventPayload: json('eventPayload').notNull(),
  eventFingerprint: varchar('eventFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_modelops_event_id_unique').on(table.eventId),
  uniqueIndex('geo_outcome_modelops_event_fingerprint_unique').on(table.ownerUserId, table.eventFingerprint),
  index('geo_outcome_modelops_event_cycle_idx').on(table.ownerUserId, table.cycleId, table.createdAt),
])

/** Durable shadow evaluation windows and diagnostics; no prediction or causal claims are stored. */
export const geoOutcomeModelopsShadowEvaluations = mysqlTable('geoOutcomeModelopsShadowEvaluations', {
  id: int('id').autoincrement().primaryKey(),
  evaluationId: varchar('evaluationId', { length: 160 }).notNull(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  artifactId: varchar('artifactId', { length: 160 }).notNull(),
  artifactHash: varchar('artifactHash', { length: 128 }).notNull(),
  evaluationWindowStart: timestamp('evaluationWindowStart').notNull(),
  evaluationWindowEnd: timestamp('evaluationWindowEnd').notNull(),
  observationFingerprints: json('observationFingerprints').notNull(),
  candidateCount: int('candidateCount').notNull(),
  positiveCount: int('positiveCount').notNull(),
  negativeCount: int('negativeCount').notNull(),
  queryGroupCount: int('queryGroupCount').notNull(),
  websiteCount: int('websiteCount').notNull(),
  engineCounts: json('engineCounts').notNull(),
  binaryMetrics: json('binaryMetrics').notNull(),
  rankingMetrics: json('rankingMetrics').notNull(),
  calibrationDiagnostics: json('calibrationDiagnostics').notNull(),
  driftDiagnostics: json('driftDiagnostics').notNull(),
  status: mysqlEnum('status', ['completed', 'insufficient_data', 'blocked', 'needs_owner_attention']).notNull(),
  reasonCodes: json('reasonCodes').notNull(),
  evaluationFingerprint: varchar('evaluationFingerprint', { length: 128 }).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_modelops_shadow_evaluation_id_unique').on(table.ownerUserId, table.evaluationId),
  uniqueIndex('geo_outcome_modelops_shadow_evaluation_fingerprint_unique').on(table.ownerUserId, table.evaluationFingerprint),
  index('geo_outcome_modelops_shadow_artifact_idx').on(table.ownerUserId, table.artifactId, table.createdAt),
])

/** Append-only owner-confirmed rollback decision; rollback is never automatic. */
export const geoOutcomeModelopsRollbackDecisions = mysqlTable('geoOutcomeModelopsRollbackDecisions', {
  id: int('id').autoincrement().primaryKey(),
  decisionId: varchar('decisionId', { length: 160 }).notNull(),
  ownerUserId: int('ownerUserId').notNull().references(() => users.id),
  artifactId: varchar('artifactId', { length: 160 }).notNull(),
  fromArtifactHash: varchar('fromArtifactHash', { length: 128 }).notNull(),
  rollbackArtifactHash: varchar('rollbackArtifactHash', { length: 128 }).notNull(),
  reviewerUserId: int('reviewerUserId').notNull().references(() => users.id),
  reason: varchar('reason', { length: 500 }).notNull(),
  decisionStatus: mysqlEnum('decisionStatus', ['approved', 'rejected']).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [
  uniqueIndex('geo_outcome_modelops_rollback_decision_unique').on(table.decisionId),
  index('geo_outcome_modelops_rollback_owner_artifact_idx').on(table.ownerUserId, table.artifactId, table.createdAt),
])

export type GeoOutcomeModelopsPolicy = typeof geoOutcomeModelopsPolicies.$inferSelect
export type GeoOutcomeModelopsCycle = typeof geoOutcomeModelopsCycles.$inferSelect
export type GeoOutcomeModelopsEvent = typeof geoOutcomeModelopsEvents.$inferSelect
export type GeoOutcomeModelopsShadowEvaluation = typeof geoOutcomeModelopsShadowEvaluations.$inferSelect
export type GeoOutcomeModelopsRollbackDecision = typeof geoOutcomeModelopsRollbackDecisions.$inferSelect
