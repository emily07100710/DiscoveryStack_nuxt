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
ALTER TABLE `geoOutcomeDatasetDecisions` ADD CONSTRAINT `geoOutcomeDatasetDecisions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetDecisions` ADD CONSTRAINT `geoOutcomeDatasetDecisions_datasetManifestId_geoOutcomeDatasetManifests_id_fk` FOREIGN KEY (`datasetManifestId`) REFERENCES `geoOutcomeDatasetManifests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetDecisions` ADD CONSTRAINT `geoOutcomeDatasetDecisions_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetManifests` ADD CONSTRAINT `geoOutcomeDatasetManifests_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetMembers` ADD CONSTRAINT `geoOutcomeDatasetMembers_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetMembers` ADD CONSTRAINT `geoOutcomeDatasetMembers_datasetManifestId_geoOutcomeDatasetManifests_id_fk` FOREIGN KEY (`datasetManifestId`) REFERENCES `geoOutcomeDatasetManifests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `geoOutcomeEvidenceLocators_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `geoOutcomeEvidenceLocators_sourceRecordId_llmVisibilityObservations_id_fk` FOREIGN KEY (`sourceRecordId`) REFERENCES `llmVisibilityObservations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `geoOutcomeEvidenceLocators_sourceProjectId_llmVisibilityProjects_id_fk` FOREIGN KEY (`sourceProjectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `geoOutcomeEvidenceLocators_sourceQueryId_llmVisibilityQueries_id_fk` FOREIGN KEY (`sourceQueryId`) REFERENCES `llmVisibilityQueries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `geoOutcomeEvidenceLocators_sourceRunId_llmVisibilityRuns_id_fk` FOREIGN KEY (`sourceRunId`) REFERENCES `llmVisibilityRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeIdempotencyClaims` ADD CONSTRAINT `geoOutcomeIdempotencyClaims_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelArtifacts` ADD CONSTRAINT `geoOutcomeModelArtifacts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelDecisions` ADD CONSTRAINT `geoOutcomeModelDecisions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelDecisions` ADD CONSTRAINT `geoOutcomeModelDecisions_modelArtifactId_geoOutcomeModelArtifacts_id_fk` FOREIGN KEY (`modelArtifactId`) REFERENCES `geoOutcomeModelArtifacts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelDecisions` ADD CONSTRAINT `geoOutcomeModelDecisions_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD CONSTRAINT `geoOutcomeObservationCandidates_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD CONSTRAINT `geoOutcomeObservationCandidates_observationRunId_geoOutcomeObservationRuns_id_fk` FOREIGN KEY (`observationRunId`) REFERENCES `geoOutcomeObservationRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationRuns` ADD CONSTRAINT `geoOutcomeObservationRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` ADD CONSTRAINT `geoOutcomeObservationVerifications_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` ADD CONSTRAINT `geoOutcomeObservationVerifications_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD CONSTRAINT `geoOutcomeTrainingRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD CONSTRAINT `geoOutcomeTrainingRuns_datasetManifestId_geoOutcomeDatasetManifests_id_fk` FOREIGN KEY (`datasetManifestId`) REFERENCES `geoOutcomeDatasetManifests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX `geo_outcome_training_owner_status_idx` ON `geoOutcomeTrainingRuns` (`ownerUserId`,`status`,`createdAt`);