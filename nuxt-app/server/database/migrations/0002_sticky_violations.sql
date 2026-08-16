CREATE TABLE `publicIntelligenceArtifacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceId` int NOT NULL,
	`sourceUrl` varchar(2048) NOT NULL,
	`canonicalUrl` varchar(2048),
	`artifactType` enum('page_manifest','structural_features','topic_map','entity_map','semantic_features','technical_seo','derived_excerpt','human_annotation') NOT NULL,
	`artifactText` text,
	`sourceLocator` varchar(1024),
	`sourceSpanHash` varchar(128),
	`fieldData` json NOT NULL,
	`artifactHash` varchar(128) NOT NULL,
	`language` varchar(24),
	`extractionMethod` enum('manual','public_api','policy_approved_fetch','human_annotation') NOT NULL,
	`extractionVersion` varchar(80) NOT NULL,
	`useSnapshot` enum('research_only','evaluation_candidate','training_candidate','blocked') NOT NULL,
	`qualityStatus` enum('pending','passed','needs_revision','rejected') NOT NULL DEFAULT 'pending',
	`piiStatus` enum('unreviewed','none_detected','possible','restricted') NOT NULL DEFAULT 'unreviewed',
	`capturedAt` timestamp NOT NULL,
	`retentionUntil` timestamp,
	`removedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `publicIntelligenceArtifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `public_intelligence_artifact_hash_unique` UNIQUE(`artifactHash`)
);
--> statement-breakpoint
CREATE TABLE `publicIntelligenceDatasetBuilds` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`datasetName` varchar(160) NOT NULL,
	`datasetVersion` varchar(80) NOT NULL,
	`intendedUse` enum('research','evaluation','training') NOT NULL,
	`policyFilter` json NOT NULL,
	`featureContractVersion` varchar(80) NOT NULL,
	`labelTaxonomyVersion` varchar(80),
	`splitVersion` varchar(80),
	`manifestHash` varchar(128) NOT NULL,
	`status` enum('draft','ready_for_review','approved','archived','revoked') NOT NULL DEFAULT 'draft',
	`reviewerUserId` int,
	`reviewNote` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`approvedAt` timestamp,
	CONSTRAINT `publicIntelligenceDatasetBuilds_id` PRIMARY KEY(`id`),
	CONSTRAINT `public_intelligence_dataset_version_unique` UNIQUE(`datasetName`,`datasetVersion`)
);
--> statement-breakpoint
CREATE TABLE `publicIntelligenceDatasetMembers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`datasetBuildId` int NOT NULL,
	`artifactId` int NOT NULL,
	`dataSplit` enum('unassigned','train','validation','test','holdout') NOT NULL DEFAULT 'unassigned',
	`inclusionReason` text NOT NULL,
	`reviewerUserId` int NOT NULL,
	`memberStatus` enum('included','excluded','revoked') NOT NULL DEFAULT 'included',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	CONSTRAINT `publicIntelligenceDatasetMembers_id` PRIMARY KEY(`id`),
	CONSTRAINT `public_intelligence_dataset_member_unique` UNIQUE(`datasetBuildId`,`artifactId`)
);
--> statement-breakpoint
CREATE TABLE `publicIntelligenceSources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceFingerprint` varchar(64) NOT NULL,
	`sourceType` enum('website','api','dataset','publication','document') NOT NULL,
	`sourceUrl` varchar(2048) NOT NULL,
	`canonicalUrl` varchar(2048),
	`sourceName` varchar(300),
	`domain` varchar(253),
	`language` varchar(24),
	`region` varchar(80),
	`discoveryMethod` enum('owner_research','public_search','api_catalogue','licensed_import') NOT NULL,
	`robotsStatus` enum('unreviewed','reviewed_allow','reviewed_restrict','unavailable','not_applicable') NOT NULL DEFAULT 'unreviewed',
	`robotsUrl` varchar(2048),
	`robotsEvidenceHash` varchar(128),
	`termsStatus` enum('unreviewed','allows_research','allows_evaluation','allows_training','prohibits_automation','prohibits_training','unknown') NOT NULL DEFAULT 'unreviewed',
	`termsUrl` varchar(2048),
	`licenceReference` varchar(500),
	`copyrightRisk` enum('unreviewed','low','medium','high','blocked') NOT NULL DEFAULT 'unreviewed',
	`piiStatus` enum('unreviewed','none_detected','possible','restricted') NOT NULL DEFAULT 'unreviewed',
	`allowedUse` enum('research_only','evaluation_candidate','training_candidate','blocked') NOT NULL DEFAULT 'research_only',
	`reviewStatus` enum('pending','approved','needs_policy_review','rejected','removed') NOT NULL DEFAULT 'pending',
	`policyEvidence` json NOT NULL,
	`reviewNote` text,
	`firstObservedAt` timestamp NOT NULL,
	`lastReviewedAt` timestamp,
	`retentionUntil` timestamp,
	`removalRequestedAt` timestamp,
	`removedAt` timestamp,
	`sourceCardVersion` varchar(80) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `publicIntelligenceSources_id` PRIMARY KEY(`id`),
	CONSTRAINT `public_intelligence_source_fingerprint_unique` UNIQUE(`sourceFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `publicIntelligenceArtifacts` ADD CONSTRAINT `pia_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceDatasetBuilds` ADD CONSTRAINT `pidb_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceDatasetBuilds` ADD CONSTRAINT `pidb_reviewer_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceDatasetMembers` ADD CONSTRAINT `pidm_build_fk` FOREIGN KEY (`datasetBuildId`) REFERENCES `publicIntelligenceDatasetBuilds`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceDatasetMembers` ADD CONSTRAINT `pidm_artifact_fk` FOREIGN KEY (`artifactId`) REFERENCES `publicIntelligenceArtifacts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceDatasetMembers` ADD CONSTRAINT `pidm_reviewer_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceSources` ADD CONSTRAINT `pis_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `public_intelligence_artifacts_source_idx` ON `publicIntelligenceArtifacts` (`sourceId`,`artifactType`);--> statement-breakpoint
CREATE INDEX `public_intelligence_artifacts_use_idx` ON `publicIntelligenceArtifacts` (`useSnapshot`,`qualityStatus`);--> statement-breakpoint
CREATE INDEX `public_intelligence_dataset_owner_idx` ON `publicIntelligenceDatasetBuilds` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `public_intelligence_dataset_members_artifact_idx` ON `publicIntelligenceDatasetMembers` (`artifactId`,`memberStatus`);--> statement-breakpoint
CREATE INDEX `public_intelligence_sources_owner_idx` ON `publicIntelligenceSources` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `public_intelligence_sources_policy_idx` ON `publicIntelligenceSources` (`allowedUse`,`reviewStatus`);
