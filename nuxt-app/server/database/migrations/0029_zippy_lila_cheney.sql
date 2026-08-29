CREATE TABLE `geoOutcomeCandidateAuthorities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`candidateSetDecisionId` int NOT NULL,
	`sourceObservationId` int NOT NULL,
	`projectId` int NOT NULL,
	`queryId` int NOT NULL,
	`runId` int NOT NULL,
	`canonicalCandidateUrlHash` varchar(128) NOT NULL,
	`canonicalPageHash` varchar(128) NOT NULL,
	`candidatePageIdentityHash` varchar(128) NOT NULL,
	`websiteIdentityHash` varchar(128) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`publicationReceiptFingerprint` varchar(128),
	`publicationEvidenceSnapshotHash` varchar(128),
	`authorityBasis` enum('manual_owner_attested_v1','discovery_stack_publication_receipt_v1') NOT NULL,
	`observabilityReviewStatus` enum('approved_observable') NOT NULL,
	`retrievalReviewStatus` enum('approved_retrieved') NOT NULL,
	`reviewerUserId` int NOT NULL,
	`reviewReason` varchar(500) NOT NULL,
	`reviewedAt` timestamp NOT NULL,
	`decisionFingerprint` varchar(128) NOT NULL,
	`candidateSetFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeCandidateAuthorities_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_candidate_authority_set_url_unique` UNIQUE(`candidateSetDecisionId`,`canonicalCandidateUrlHash`),
	CONSTRAINT `geo_outcome_candidate_authority_set_identity_unique` UNIQUE(`candidateSetDecisionId`,`candidatePageIdentityHash`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeCandidateSetDecisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`decisionId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceObservationId` int NOT NULL,
	`sourceProjectId` int NOT NULL,
	`sourceQueryId` int NOT NULL,
	`sourceRunId` int NOT NULL,
	`sourceCitationSetFingerprint` varchar(128) NOT NULL,
	`reviewerUserId` int NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`decisionType` enum('approve','revoke') NOT NULL,
	`candidateSetFingerprint` varchar(128) NOT NULL,
	`targetCandidateSetFingerprint` varchar(128),
	`reviewReason` varchar(500) NOT NULL,
	`decisionFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeCandidateSetDecisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_candidate_sets_decision_unique` UNIQUE(`decisionId`),
	CONSTRAINT `geo_outcome_candidate_sets_owner_key_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `geo_outcome_candidate_sets_owner_source_set_decision_unique` UNIQUE(`ownerUserId`,`sourceObservationId`,`candidateSetFingerprint`,`decisionType`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeDatasetDecisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`decisionId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`datasetManifestId` int NOT NULL,
	`reviewerUserId` int NOT NULL,
	`previousStatus` varchar(96) NOT NULL,
	`newStatus` varchar(96) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`manifestFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeDatasetDecisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `geoOutcomeDatasetDecisions_decisionId_unique` UNIQUE(`decisionId`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeDatasetManifests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`manifestId` varchar(160) NOT NULL,
	`schemaVersion` varchar(96) NOT NULL,
	`taskType` enum('citation_selection','structural_readiness_auxiliary') NOT NULL,
	`featureCatalogVersion` varchar(128) NOT NULL,
	`labelContractVersion` varchar(128) NOT NULL,
	`hardNegativePolicyVersion` varchar(128) NOT NULL,
	`sourceObservationFingerprints` json NOT NULL,
	`sourceBasisCounts` json NOT NULL,
	`engineCounts` json NOT NULL,
	`localeCounts` json NOT NULL,
	`websiteCount` int NOT NULL,
	`queryGroupCount` int NOT NULL,
	`positiveCount` int NOT NULL,
	`hardNegativeCount` int NOT NULL,
	`observationStart` timestamp,
	`observationEnd` timestamp,
	`splitPolicyVersion` varchar(128) NOT NULL,
	`splitFingerprints` json NOT NULL,
	`manifestFingerprint` varchar(128) NOT NULL,
	`limitations` json NOT NULL,
	`readiness` json NOT NULL,
	`status` enum('draft','gate_blocked','ready_for_review','approved','revoked','archived') NOT NULL DEFAULT 'draft',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeDatasetManifests_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_datasets_owner_manifest_unique` UNIQUE(`ownerUserId`,`manifestId`),
	CONSTRAINT `geo_outcome_datasets_fingerprint_unique` UNIQUE(`ownerUserId`,`manifestFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeDatasetMembers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`datasetManifestId` int NOT NULL,
	`observationFingerprint` varchar(128) NOT NULL,
	`websiteIdentityHash` varchar(128) NOT NULL,
	`normalizedQueryHash` varchar(128) NOT NULL,
	`runIdentity` varchar(160) NOT NULL,
	`queryGroupKey` varchar(128) NOT NULL,
	`label` enum('positive','hard_negative') NOT NULL,
	`splitAssignment` enum('train','validation','test','site_holdout','query_holdout','temporal_holdout') NOT NULL,
	`consentStatus` enum('approved','revoked','unknown') NOT NULL DEFAULT 'unknown',
	`piiStatus` enum('clean','contains_pii','unknown') NOT NULL DEFAULT 'unknown',
	`reviewFingerprint` varchar(128),
	`featureVector` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeDatasetMembers_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_members_manifest_observation_unique` UNIQUE(`datasetManifestId`,`observationFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeEvidenceLocators` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`observationFingerprint` varchar(128) NOT NULL,
	`evidenceLocatorHash` varchar(128) NOT NULL,
	`purpose` enum('geo_outcome_verification') NOT NULL,
	`sourceKind` enum('llm_visibility_observation') NOT NULL,
	`sourceRecordId` int NOT NULL,
	`sourceProjectId` int NOT NULL,
	`sourceQueryId` int NOT NULL,
	`sourceRunId` int NOT NULL,
	`sourceResponseHash` varchar(64) NOT NULL,
	`sourceCitationSetFingerprint` varchar(128) NOT NULL,
	`candidateAuthorityId` int NOT NULL,
	`candidateAuthorityFingerprint` varchar(128) NOT NULL,
	`candidateSetFingerprint` varchar(128) NOT NULL,
	`canonicalCandidateUrlHash` varchar(128) NOT NULL,
	`serverDerivedCitationStatus` enum('cited','not_cited') NOT NULL,
	`serverDerivedCitationPosition` int,
	`evidenceBindingFingerprint` varchar(128) NOT NULL,
	`sourceObservedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeEvidenceLocators_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_evidence_binding_unique` UNIQUE(`ownerUserId`,`observationFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeIdempotencyClaims` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`routeIdentity` varchar(160) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`state` enum('claimed','completed','failed') NOT NULL DEFAULT 'claimed',
	`responseProjection` json,
	`responseFingerprint` varchar(128),
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`version` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `geoOutcomeIdempotencyClaims_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_idempotency_owner_route_key_unique` UNIQUE(`ownerUserId`,`routeIdentity`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeModelArtifacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`artifactId` varchar(160) NOT NULL,
	`artifactSchemaVersion` varchar(128) NOT NULL,
	`taskType` enum('citation_selection','structural_readiness_auxiliary') NOT NULL,
	`modelFamily` enum('regularized_logistic_baseline_v1','pairwise_logistic_ranker_v1') NOT NULL,
	`modelVersion` varchar(128) NOT NULL,
	`featureCatalogVersion` varchar(128) NOT NULL,
	`labelContractVersion` varchar(128) NOT NULL,
	`datasetManifestFingerprint` varchar(128) NOT NULL,
	`splitManifestFingerprint` varchar(128) NOT NULL,
	`coefficients` json NOT NULL,
	`intercept` decimal(24,12) NOT NULL,
	`normalizationStatistics` json NOT NULL,
	`trainingConfiguration` json NOT NULL,
	`trainingRowCount` int NOT NULL,
	`evaluationMetrics` json NOT NULL,
	`limitations` json NOT NULL,
	`artifactFingerprint` varchar(128) NOT NULL,
	`artifactHash` varchar(128) NOT NULL,
	`rollbackArtifactHash` varchar(128),
	`status` enum('development','evaluation_failed','ready_for_owner_review','approved_for_shadow','shadow_failed','revoked','archived') NOT NULL DEFAULT 'development',
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeModelArtifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_artifacts_owner_id_unique` UNIQUE(`ownerUserId`,`artifactId`),
	CONSTRAINT `geo_outcome_artifacts_hash_unique` UNIQUE(`ownerUserId`,`artifactHash`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeModelDecisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`decisionId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`modelArtifactId` int NOT NULL,
	`previousStatus` varchar(96) NOT NULL,
	`newStatus` varchar(96) NOT NULL,
	`reviewerUserId` int,
	`reason` varchar(500) NOT NULL,
	`artifactHash` varchar(128) NOT NULL,
	`datasetManifestHash` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeModelDecisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `geoOutcomeModelDecisions_decisionId_unique` UNIQUE(`decisionId`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeObservationCandidates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`observationRunId` int NOT NULL,
	`websiteIdentityHash` varchar(128) NOT NULL,
	`queryIdentityHash` varchar(128) NOT NULL,
	`normalizedQueryHash` varchar(128) NOT NULL,
	`candidatePageIdentityHash` varchar(128) NOT NULL,
	`canonicalPageHash` varchar(128) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`publicationReceiptFingerprint` varchar(128),
	`observableStatus` varchar(48) NOT NULL,
	`retrievalStatus` varchar(48) NOT NULL,
	`citationStatus` varchar(48) NOT NULL,
	`citationPosition` int,
	`mentionStatus` varchar(48) NOT NULL,
	`recommendationStatus` varchar(48) NOT NULL,
	`labelBasis` varchar(96) NOT NULL,
	`verificationStatus` varchar(48) NOT NULL,
	`consentStatus` enum('approved','revoked','unknown') NOT NULL DEFAULT 'unknown',
	`piiStatus` enum('clean','contains_pii','unknown') NOT NULL DEFAULT 'unknown',
	`verificationAuthority` varchar(96) NOT NULL DEFAULT 'none',
	`intakeFingerprint` varchar(128) NOT NULL,
	`reviewFingerprint` varchar(128),
	`observationPayload` json NOT NULL,
	`evidenceLocatorHashes` json NOT NULL,
	`appliedRuleHashes` json NOT NULL,
	`contentFeatureVector` json NOT NULL,
	`observationFingerprint` varchar(128) NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeObservationCandidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_candidates_owner_identity_unique` UNIQUE(`ownerUserId`,`observationRunId`,`candidatePageIdentityHash`),
	CONSTRAINT `geo_outcome_candidates_fingerprint_unique` UNIQUE(`ownerUserId`,`observationFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeObservationRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int,
	`clientId` varchar(128),
	`runIdentity` varchar(160) NOT NULL,
	`engine` varchar(96) NOT NULL,
	`model` varchar(160) NOT NULL,
	`modelVersion` varchar(160),
	`interface` varchar(96) NOT NULL,
	`locale` varchar(32) NOT NULL,
	`region` varchar(64),
	`observationWindowStart` timestamp NOT NULL,
	`observationWindowEnd` timestamp NOT NULL,
	`runTimestamp` timestamp NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`status` enum('received','verified','stale','revoked') NOT NULL DEFAULT 'received',
	`runFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeObservationRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_runs_owner_identity_unique` UNIQUE(`ownerUserId`,`runIdentity`),
	CONSTRAINT `geo_outcome_runs_fingerprint_unique` UNIQUE(`ownerUserId`,`runFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeObservationVerifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`observationFingerprint` varchar(128) NOT NULL,
	`reviewerUserId` int NOT NULL,
	`previousVerificationStatus` varchar(48) NOT NULL,
	`newVerificationStatus` varchar(48) NOT NULL,
	`evidenceLocatorHash` varchar(128),
	`factType` enum('evidence_verification','consent_review','pii_review','revocation') NOT NULL,
	`factStatus` enum('approved','rejected','revoked') NOT NULL,
	`reason` varchar(500) NOT NULL,
	`decisionFingerprint` varchar(128) NOT NULL,
	`consentStatus` enum('approved','revoked','unknown') NOT NULL,
	`piiStatus` enum('clean','contains_pii','unknown') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeObservationVerifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_verification_decision_unique` UNIQUE(`ownerUserId`,`decisionFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeTrainingRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`trainingRunId` varchar(160) NOT NULL,
	`datasetManifestId` int NOT NULL,
	`modelFamily` enum('regularized_logistic_baseline_v1','pairwise_logistic_ranker_v1') NOT NULL,
	`status` enum('queued','running','completed','blocked','failed') NOT NULL DEFAULT 'queued',
	`startedAt` timestamp,
	`completedAt` timestamp,
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`version` int NOT NULL DEFAULT 0,
	`configuration` json NOT NULL,
	`artifactId` varchar(160),
	`artifactHash` varchar(128),
	`metrics` json,
	`reason` varchar(500),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeTrainingRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_training_owner_id_unique` UNIQUE(`ownerUserId`,`trainingRunId`)
);
--> statement-breakpoint
CREATE TABLE `llmVisibilityObservationReviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`decisionId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`observationId` int NOT NULL,
	`reviewerUserId` int NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`previousStatus` enum('pending','approved','revoked') NOT NULL,
	`newStatus` enum('approved','revoked') NOT NULL,
	`reason` varchar(500) NOT NULL,
	`sourceResponseHash` varchar(64) NOT NULL,
	`decisionFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `llmVisibilityObservationReviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_visibility_reviews_decision_unique` UNIQUE(`decisionId`),
	CONSTRAINT `llm_visibility_reviews_owner_key_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `llm_visibility_reviews_observation_status_unique` UNIQUE(`observationId`,`newStatus`)
);
--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateAuthorities` ADD CONSTRAINT `geoOutcomeCandidateAuthorities_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateAuthorities` ADD CONSTRAINT `fk_geo_outcome_candidate_au_candidate_set_deci_0d82681797` FOREIGN KEY (`candidateSetDecisionId`) REFERENCES `geoOutcomeCandidateSetDecisions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateAuthorities` ADD CONSTRAINT `fk_geo_outcome_candidate_au_source_observation_b86bb57cf5` FOREIGN KEY (`sourceObservationId`) REFERENCES `llmVisibilityObservations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateAuthorities` ADD CONSTRAINT `fk_geo_outcome_candidate_au_project_id_11711cc81a` FOREIGN KEY (`projectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateAuthorities` ADD CONSTRAINT `fk_geo_outcome_candidate_au_query_id_6e9aef239a` FOREIGN KEY (`queryId`) REFERENCES `llmVisibilityQueries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateAuthorities` ADD CONSTRAINT `geoOutcomeCandidateAuthorities_runId_llmVisibilityRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `llmVisibilityRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateAuthorities` ADD CONSTRAINT `geoOutcomeCandidateAuthorities_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateSetDecisions` ADD CONSTRAINT `geoOutcomeCandidateSetDecisions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateSetDecisions` ADD CONSTRAINT `fk_geo_outcome_candidate_se_source_observation_e0c81fd59e` FOREIGN KEY (`sourceObservationId`) REFERENCES `llmVisibilityObservations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateSetDecisions` ADD CONSTRAINT `fk_geo_outcome_candidate_se_source_project_id_efbe5b4fce` FOREIGN KEY (`sourceProjectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateSetDecisions` ADD CONSTRAINT `fk_geo_outcome_candidate_se_source_query_id_ba67e6445f` FOREIGN KEY (`sourceQueryId`) REFERENCES `llmVisibilityQueries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateSetDecisions` ADD CONSTRAINT `fk_geo_outcome_candidate_se_source_run_id_b3b875d82f` FOREIGN KEY (`sourceRunId`) REFERENCES `llmVisibilityRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeCandidateSetDecisions` ADD CONSTRAINT `geoOutcomeCandidateSetDecisions_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetDecisions` ADD CONSTRAINT `geoOutcomeDatasetDecisions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetDecisions` ADD CONSTRAINT `fk_geo_outcome_dataset_deci_dataset_manifest_i_4255ddaa11` FOREIGN KEY (`datasetManifestId`) REFERENCES `geoOutcomeDatasetManifests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetDecisions` ADD CONSTRAINT `geoOutcomeDatasetDecisions_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetManifests` ADD CONSTRAINT `geoOutcomeDatasetManifests_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetMembers` ADD CONSTRAINT `geoOutcomeDatasetMembers_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetMembers` ADD CONSTRAINT `fk_geo_outcome_dataset_memb_dataset_manifest_i_103bf1da95` FOREIGN KEY (`datasetManifestId`) REFERENCES `geoOutcomeDatasetManifests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `geoOutcomeEvidenceLocators_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `fk_geo_outcome_evidence_loc_source_record_id_f8799fa069` FOREIGN KEY (`sourceRecordId`) REFERENCES `llmVisibilityObservations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `fk_geo_outcome_evidence_loc_source_project_id_ae0cf5937c` FOREIGN KEY (`sourceProjectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `fk_geo_outcome_evidence_loc_source_query_id_1a9420ef37` FOREIGN KEY (`sourceQueryId`) REFERENCES `llmVisibilityQueries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `geoOutcomeEvidenceLocators_sourceRunId_llmVisibilityRuns_id_fk` FOREIGN KEY (`sourceRunId`) REFERENCES `llmVisibilityRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `fk_geo_outcome_evidence_loc_candidate_authorit_fcd357368f` FOREIGN KEY (`candidateAuthorityId`) REFERENCES `geoOutcomeCandidateAuthorities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeIdempotencyClaims` ADD CONSTRAINT `geoOutcomeIdempotencyClaims_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelArtifacts` ADD CONSTRAINT `geoOutcomeModelArtifacts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelDecisions` ADD CONSTRAINT `geoOutcomeModelDecisions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelDecisions` ADD CONSTRAINT `fk_geo_outcome_model_decisi_model_artifact_id_fb788115d0` FOREIGN KEY (`modelArtifactId`) REFERENCES `geoOutcomeModelArtifacts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelDecisions` ADD CONSTRAINT `geoOutcomeModelDecisions_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD CONSTRAINT `geoOutcomeObservationCandidates_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD CONSTRAINT `fk_geo_outcome_observation__observation_run_id_31c51a97f4` FOREIGN KEY (`observationRunId`) REFERENCES `geoOutcomeObservationRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationRuns` ADD CONSTRAINT `geoOutcomeObservationRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` ADD CONSTRAINT `geoOutcomeObservationVerifications_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` ADD CONSTRAINT `geoOutcomeObservationVerifications_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD CONSTRAINT `geoOutcomeTrainingRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD CONSTRAINT `fk_geo_outcome_training_run_dataset_manifest_i_0df694f82e` FOREIGN KEY (`datasetManifestId`) REFERENCES `geoOutcomeDatasetManifests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityObservationReviews` ADD CONSTRAINT `llmVisibilityObservationReviews_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityObservationReviews` ADD CONSTRAINT `fk_llm_visibility_observati_observation_id_16b5f0f3b7` FOREIGN KEY (`observationId`) REFERENCES `llmVisibilityObservations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityObservationReviews` ADD CONSTRAINT `llmVisibilityObservationReviews_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `geo_outcome_candidate_authority_source_idx` ON `geoOutcomeCandidateAuthorities` (`ownerUserId`,`sourceObservationId`,`candidateSetFingerprint`);--> statement-breakpoint
CREATE INDEX `geo_outcome_candidate_sets_source_idx` ON `geoOutcomeCandidateSetDecisions` (`ownerUserId`,`sourceObservationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_dataset_decisions_owner_manifest_idx` ON `geoOutcomeDatasetDecisions` (`ownerUserId`,`datasetManifestId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_datasets_owner_status_idx` ON `geoOutcomeDatasetManifests` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_members_owner_query_idx` ON `geoOutcomeDatasetMembers` (`ownerUserId`,`normalizedQueryHash`);--> statement-breakpoint
CREATE INDEX `geo_outcome_evidence_observation_idx` ON `geoOutcomeEvidenceLocators` (`ownerUserId`,`observationFingerprint`);--> statement-breakpoint
CREATE INDEX `geo_outcome_idempotency_lease_idx` ON `geoOutcomeIdempotencyClaims` (`state`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_artifacts_owner_status_idx` ON `geoOutcomeModelArtifacts` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_decisions_owner_artifact_idx` ON `geoOutcomeModelDecisions` (`ownerUserId`,`modelArtifactId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_candidates_owner_query_idx` ON `geoOutcomeObservationCandidates` (`ownerUserId`,`normalizedQueryHash`,`observationRunId`);--> statement-breakpoint
CREATE INDEX `geo_outcome_runs_owner_time_idx` ON `geoOutcomeObservationRuns` (`ownerUserId`,`runTimestamp`);--> statement-breakpoint
CREATE INDEX `geo_outcome_verification_observation_idx` ON `geoOutcomeObservationVerifications` (`ownerUserId`,`observationFingerprint`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_training_owner_status_idx` ON `geoOutcomeTrainingRuns` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `llm_visibility_reviews_owner_observation_idx` ON `llmVisibilityObservationReviews` (`ownerUserId`,`observationId`,`createdAt`);