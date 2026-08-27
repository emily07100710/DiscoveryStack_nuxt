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
	`effectiveAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationEntityStrategyProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_entity_profile_owner_id_unique` UNIQUE(`ownerUserId`,`profileId`),
	CONSTRAINT `content_operation_entity_profile_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`profileFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationMachineAuthorizations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`authorizationId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`websiteId` varchar(128) NOT NULL,
	`entryId` int NOT NULL,
	`draftId` int NOT NULL,
	`policyId` varchar(160) NOT NULL,
	`policyVersion` varchar(128) NOT NULL,
	`candidateId` varchar(160) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`riskClass` varchar(40) NOT NULL,
	`qualityStatus` varchar(40) NOT NULL,
	`targetId` varchar(160) NOT NULL,
	`authorizationPayload` json NOT NULL,
	`authorizationFingerprint` varchar(128) NOT NULL,
	`status` enum('authorized','published','revoked') NOT NULL DEFAULT 'authorized',
	`decidedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationMachineAuthorizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_machine_auth_owner_id_unique` UNIQUE(`ownerUserId`,`authorizationId`),
	CONSTRAINT `content_operation_machine_auth_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`authorizationFingerprint`)
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
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	CONSTRAINT `contentOperationQueryOwnership_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_query_ownership_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`fingerprint`)
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
ALTER TABLE `contentOperationAutopilotPolicies` ADD `mode` enum('balanced','aggressive_growth','conservative_brand') DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `websiteId` varchar(128) DEFAULT 'legacy-website' NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedDestinations` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedCadences` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedRiskClasses` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `entityStrategyProfileId` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `maximumRepairAttempts` int DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `maximumTopicSubstitutions` int DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `generationBudget` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `publicationBudget` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationEntityStrategyProfiles` ADD CONSTRAINT `contentOperationEntityStrategyProfiles_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEntityStrategyProfiles` ADD CONSTRAINT `contentOperationEntityStrategyProfiles_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `contentOperationMachineAuthorizations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `contentOperationMachineAuthorizations_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `contentOperationMachineAuthorizations_entryId_contentOperationCalendarEntries_id_fk` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `contentOperationMachineAuthorizations_draftId_seoGeoContentDrafts_id_fk` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationQueryOwnership` ADD CONSTRAINT `contentOperationQueryOwnership_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationQueryOwnership` ADD CONSTRAINT `contentOperationQueryOwnership_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationRepairAttempts` ADD CONSTRAINT `contentOperationRepairAttempts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationRepairAttempts` ADD CONSTRAINT `contentOperationRepairAttempts_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationRepairAttempts` ADD CONSTRAINT `contentOperationRepairAttempts_entryId_contentOperationCalendarEntries_id_fk` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationTopicSubstitutions` ADD CONSTRAINT `contentOperationTopicSubstitutions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationTopicSubstitutions` ADD CONSTRAINT `contentOperationTopicSubstitutions_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationTopicSubstitutions` ADD CONSTRAINT `contentOperationTopicSubstitutions_entryId_contentOperationCalendarEntries_id_fk` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `content_operation_entity_profile_owner_scope_idx` ON `contentOperationEntityStrategyProfiles` (`ownerUserId`,`clientId`,`websiteId`,`status`);--> statement-breakpoint
CREATE INDEX `content_operation_machine_auth_owner_entry_idx` ON `contentOperationMachineAuthorizations` (`ownerUserId`,`entryId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `content_operation_query_ownership_scope_query_idx` ON `contentOperationQueryOwnership` (`ownerUserId`,`clientId`,`websiteId`,`normalizedQuery`,`status`);--> statement-breakpoint
CREATE INDEX `content_operation_repair_owner_entry_idx` ON `contentOperationRepairAttempts` (`ownerUserId`,`entryId`,`repairAttempt`);--> statement-breakpoint
CREATE INDEX `content_operation_substitution_owner_entry_idx` ON `contentOperationTopicSubstitutions` (`ownerUserId`,`entryId`,`substitutionAttempt`);