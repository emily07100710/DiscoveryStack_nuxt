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
  discoveryMethod: mysqlEnum('discoveryMethod', ['owner_research', 'public_search', 'api_catalogue', 'licensed_import']).notNull(),
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
  provider: mysqlEnum('provider', ['huggingface_jobs']).default('huggingface_jobs').notNull(),
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
export type PublicIntelligenceDatasetBuild = typeof publicIntelligenceDatasetBuilds.$inferSelect
export type PublicIntelligenceIngestionJob = typeof publicIntelligenceIngestionJobs.$inferSelect
export type PublicIntelligenceInference = typeof publicIntelligenceInferences.$inferSelect
