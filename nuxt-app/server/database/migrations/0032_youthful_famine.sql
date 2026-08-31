CREATE TABLE `contentOperationBudgetReservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`policyId` varchar(160) NOT NULL,
	`publicationTargetId` int NOT NULL,
	`entryId` int NOT NULL,
	`kind` enum('generation','publication') NOT NULL,
	`units` int NOT NULL,
	`idempotencyKey` varchar(160) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationBudgetReservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_budget_owner_key_unique` UNIQUE(`ownerUserId`,`policyId`,`kind`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationEntityStrategyProfiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`profileId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`websiteId` varchar(128) NOT NULL,
	`canonicalBrandName` varchar(160) NOT NULL,
	`brandAliases` json NOT NULL,
	`canonicalWebsiteOrigin` varchar(2048) NOT NULL,
	`businessType` varchar(160) NOT NULL,
	`primaryLocale` varchar(32) NOT NULL,
	`secondaryLocales` json NOT NULL,
	`primaryLocations` json NOT NULL,
	`serviceAreas` json NOT NULL,
	`primaryServices` json NOT NULL,
	`secondaryServices` json NOT NULL,
	`targetAudience` json NOT NULL,
	`primaryQueryClusters` json NOT NULL,
	`supportingQueryClusters` json NOT NULL,
	`canonicalPillarPages` json NOT NULL,
	`servicePageBindings` json NOT NULL,
	`approvedBrandFacts` json NOT NULL,
	`approvedDifferentiators` json NOT NULL,
	`prohibitedClaims` json NOT NULL,
	`preferredTone` varchar(160) NOT NULL,
	`requiredDisclosures` json NOT NULL,
	`internalLinkPolicy` varchar(500) NOT NULL,
	`structuredDataIdentity` json NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`profileFingerprint` varchar(128) NOT NULL,
	`version` int NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`activeScopeKey` varchar(128),
	`effectiveAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationEntityStrategyProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_entity_profile_owner_id_unique` UNIQUE(`ownerUserId`,`profileId`),
	CONSTRAINT `content_operation_entity_profile_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`profileFingerprint`),
	CONSTRAINT `content_operation_entity_profile_active_scope_unique` UNIQUE(`ownerUserId`,`activeScopeKey`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationMachineAuthorizations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`authorizationId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`websiteId` varchar(128) NOT NULL,
	`entryId` int NOT NULL,
	`jobId` int,
	`draftId` int NOT NULL,
	`publicationTargetId` int,
	`policyId` varchar(160) NOT NULL,
	`policyVersion` varchar(128) NOT NULL,
	`candidateId` varchar(160) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`policyFingerprint` varchar(128),
	`entityProfileFingerprint` varchar(128),
	`queryOwnershipFingerprint` varchar(128),
	`riskClass` varchar(40) NOT NULL,
	`riskFingerprint` varchar(128),
	`qualityStatus` varchar(40) NOT NULL,
	`qualityFingerprint` varchar(128),
	`targetId` varchar(160) NOT NULL,
	`authorizationPayload` json NOT NULL,
	`authorizationFingerprint` varchar(128) NOT NULL,
	`status` enum('authorized','executing','published','revoked') NOT NULL DEFAULT 'authorized',
	`decidedAt` timestamp NOT NULL,
	`authorizationExpiresAt` timestamp,
	`claimedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationMachineAuthorizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_machine_auth_owner_id_unique` UNIQUE(`ownerUserId`,`authorizationId`),
	CONSTRAINT `content_operation_machine_auth_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`authorizationFingerprint`),
	CONSTRAINT `content_operation_machine_auth_owner_target_unique` UNIQUE(`ownerUserId`,`entryId`,`publicationTargetId`,`authorizationFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationQueryOwnership` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`websiteId` varchar(128) NOT NULL,
	`ownerPageId` varchar(256) NOT NULL,
	`normalizedQuery` varchar(500) NOT NULL,
	`queryCluster` varchar(256) NOT NULL,
	`supportingArticleIds` json NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`fingerprint` varchar(128) NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`activeScopeKey` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	CONSTRAINT `contentOperationQueryOwnership_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_query_ownership_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`fingerprint`),
	CONSTRAINT `content_operation_query_ownership_active_scope_unique` UNIQUE(`ownerUserId`,`activeScopeKey`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationRepairAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`websiteId` varchar(128) NOT NULL,
	`entryId` int NOT NULL,
	`originalDraftId` varchar(160) NOT NULL,
	`originalContentHash` varchar(128) NOT NULL,
	`repairAttempt` int NOT NULL,
	`reasonCodes` json NOT NULL,
	`failingMetrics` json NOT NULL,
	`evidenceDeficiencies` json NOT NULL,
	`entityCoverageDeficiencies` json NOT NULL,
	`prohibitedClaimLocations` json NOT NULL,
	`citationDeficiencies` json NOT NULL,
	`keywordStuffingLocations` json NOT NULL,
	`internalLinkDeficiencies` json NOT NULL,
	`requestedRepairs` json NOT NULL,
	`providerModel` varchar(160),
	`repairedDraftId` varchar(160),
	`repairedContentHash` varchar(128),
	`parentLineage` json NOT NULL,
	`repairFingerprint` varchar(128) NOT NULL,
	`status` enum('planned','succeeded','failed','skipped') NOT NULL DEFAULT 'planned',
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationRepairAttempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_repair_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`repairFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationTopicSubstitutions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`websiteId` varchar(128) NOT NULL,
	`entryId` int NOT NULL,
	`substitutionAttempt` int NOT NULL,
	`originalTopic` varchar(500) NOT NULL,
	`substitutedTopic` varchar(500) NOT NULL,
	`reasonCodes` json NOT NULL,
	`lineage` json NOT NULL,
	`substitutionFingerprint` varchar(128) NOT NULL,
	`status` enum('planned','applied','skipped') NOT NULL DEFAULT 'planned',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationTopicSubstitutions_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_substitution_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`substitutionFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeModelopsAdvisoryAssignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assignmentId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`policyId` varchar(160) NOT NULL,
	`policyFingerprint` varchar(128) NOT NULL,
	`currentArtifactHash` varchar(128) NOT NULL,
	`candidateArtifactHash` varchar(128) NOT NULL,
	`shadowEvaluationFingerprint` varchar(128) NOT NULL,
	`cycleId` varchar(160),
	`candidateArtifactId` varchar(160),
	`datasetFingerprint` varchar(128),
	`splitFingerprint` varchar(128),
	`metricsFingerprint` varchar(128),
	`reasonCodes` json,
	`productionActivation` boolean NOT NULL DEFAULT false,
	`status` enum('advisory','rolled_back') NOT NULL DEFAULT 'advisory',
	`activeScopeKey` varchar(128),
	`version` int NOT NULL DEFAULT 1,
	`rollbackFromAssignmentId` varchar(160),
	`assignmentFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`rolledBackAt` timestamp,
	CONSTRAINT `geoOutcomeModelopsAdvisoryAssignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_modelops_advisory_assignment_unique` UNIQUE(`ownerUserId`,`assignmentId`),
	CONSTRAINT `geo_outcome_modelops_advisory_fingerprint_unique` UNIQUE(`ownerUserId`,`assignmentFingerprint`),
	CONSTRAINT `geo_outcome_modelops_advisory_active_unique` UNIQUE(`ownerUserId`,`activeScopeKey`)
);
--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetDecisions` DROP FOREIGN KEY `geoOutcomeDatasetDecisions_reviewerUserId_users_id_fk`;
--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetDecisions` MODIFY COLUMN `reviewerUserId` int;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `mode` enum('balanced','aggressive_growth','conservative_brand') DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `websiteId` varchar(128) DEFAULT 'legacy-website' NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedDestinations` json NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedCadences` json NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedRiskClasses` json NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `riskSemanticsVersion` varchar(96);--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `maximumRiskSeverity` varchar(40);--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedBusinessRiskClasses` json;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `entityStrategyProfileId` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `maximumRepairAttempts` int DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `maximumTopicSubstitutions` int DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `generationBudget` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `publicationBudget` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `generationBudgetUsed` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `publicationBudgetUsed` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `replacementOfEntryId` int;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `replacementFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsCycles` ADD `leaseVersion` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsPolicies` ADD `autonomousExecutionEnabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `content_operation_entries_owner_replacement_unique` UNIQUE(`ownerUserId`,`replacementFingerprint`);--> statement-breakpoint
ALTER TABLE `contentOperationBudgetReservations` ADD CONSTRAINT `contentOperationBudgetReservations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationBudgetReservations` ADD CONSTRAINT `fk_content_operation_budget_publication_target_301e2f78f9` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationBudgetReservations` ADD CONSTRAINT `fk_content_operation_budget_entry_id_f9984d8a11` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEntityStrategyProfiles` ADD CONSTRAINT `contentOperationEntityStrategyProfiles_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEntityStrategyProfiles` ADD CONSTRAINT `fk_content_operation_entity_client_id_93fa2c6912` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `contentOperationMachineAuthorizations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `fk_content_operation_machin_client_id_786cef497a` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `fk_content_operation_machin_entry_id_07afe0cb6d` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `fk_content_operation_machin_job_id_305a9e3c04` FOREIGN KEY (`jobId`) REFERENCES `seoGeoContentJobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `fk_content_operation_machin_draft_id_8fb1f6c556` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `fk_content_operation_machin_publication_target_7e7e3215e9` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationQueryOwnership` ADD CONSTRAINT `contentOperationQueryOwnership_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationQueryOwnership` ADD CONSTRAINT `fk_content_operation_query__client_id_ae8ba34aa7` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationRepairAttempts` ADD CONSTRAINT `contentOperationRepairAttempts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationRepairAttempts` ADD CONSTRAINT `fk_content_operation_repair_client_id_c44092d2bd` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationRepairAttempts` ADD CONSTRAINT `fk_content_operation_repair_entry_id_c4a371cc0a` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationTopicSubstitutions` ADD CONSTRAINT `contentOperationTopicSubstitutions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationTopicSubstitutions` ADD CONSTRAINT `fk_content_operation_topic__client_id_a49c8626e8` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationTopicSubstitutions` ADD CONSTRAINT `fk_content_operation_topic__entry_id_56892ad217` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD CONSTRAINT `geoOutcomeModelopsAdvisoryAssignments_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `content_operation_budget_owner_policy_idx` ON `contentOperationBudgetReservations` (`ownerUserId`,`policyId`,`kind`);--> statement-breakpoint
CREATE INDEX `content_operation_entity_profile_owner_scope_idx` ON `contentOperationEntityStrategyProfiles` (`ownerUserId`,`clientId`,`websiteId`,`status`);--> statement-breakpoint
CREATE INDEX `content_operation_machine_auth_owner_entry_idx` ON `contentOperationMachineAuthorizations` (`ownerUserId`,`entryId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `content_operation_query_ownership_scope_query_idx` ON `contentOperationQueryOwnership` (`ownerUserId`,`clientId`,`websiteId`,`normalizedQuery`,`status`);--> statement-breakpoint
CREATE INDEX `content_operation_repair_owner_entry_idx` ON `contentOperationRepairAttempts` (`ownerUserId`,`entryId`,`repairAttempt`);--> statement-breakpoint
CREATE INDEX `content_operation_substitution_owner_entry_idx` ON `contentOperationTopicSubstitutions` (`ownerUserId`,`entryId`,`substitutionAttempt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_modelops_policy_scheduler_idx` ON `geoOutcomeModelopsPolicies` (`status`,`expiresAt`,`ownerUserId`,`updatedAt`);