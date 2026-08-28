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
CREATE TABLE `geoOutcomeModelopsAdvisoryAssignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assignmentId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`policyId` varchar(160) NOT NULL,
	`policyFingerprint` varchar(128) NOT NULL,
	`currentArtifactHash` varchar(128) NOT NULL,
	`candidateArtifactHash` varchar(128) NOT NULL,
	`shadowEvaluationFingerprint` varchar(128) NOT NULL,
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
ALTER TABLE `contentOperationMachineAuthorizations` MODIFY COLUMN `status` enum('authorized','executing','published','revoked') NOT NULL DEFAULT 'authorized';--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `riskSemanticsVersion` varchar(96);--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `maximumRiskSeverity` varchar(40);--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedBusinessRiskClasses` json;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `generationBudgetUsed` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `publicationBudgetUsed` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `replacementOfEntryId` int;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `replacementFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationEntityStrategyProfiles` ADD `activeScopeKey` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `jobId` int;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `publicationTargetId` int;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `policyFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `entityProfileFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `queryOwnershipFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `riskFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `qualityFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `authorizationExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `claimedAt` timestamp;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD `revokedAt` timestamp;--> statement-breakpoint
ALTER TABLE `contentOperationQueryOwnership` ADD `activeScopeKey` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationRepairAttempts` ADD `leaseOwner` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationRepairAttempts` ADD `leaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `content_operation_entries_owner_replacement_unique` UNIQUE(`ownerUserId`,`replacementFingerprint`);--> statement-breakpoint
ALTER TABLE `contentOperationEntityStrategyProfiles` ADD CONSTRAINT `content_operation_entity_profile_active_scope_unique` UNIQUE(`ownerUserId`,`activeScopeKey`);--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `content_operation_machine_auth_owner_target_unique` UNIQUE(`ownerUserId`,`entryId`,`publicationTargetId`,`authorizationFingerprint`);--> statement-breakpoint
ALTER TABLE `contentOperationQueryOwnership` ADD CONSTRAINT `content_operation_query_ownership_active_scope_unique` UNIQUE(`ownerUserId`,`activeScopeKey`);--> statement-breakpoint
ALTER TABLE `contentOperationBudgetReservations` ADD CONSTRAINT `contentOperationBudgetReservations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationBudgetReservations` ADD CONSTRAINT `contentOperationBudgetReservations_publicationTargetId_contentOperationPublicationTargets_id_fk` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationBudgetReservations` ADD CONSTRAINT `contentOperationBudgetReservations_entryId_contentOperationCalendarEntries_id_fk` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD CONSTRAINT `geoOutcomeModelopsAdvisoryAssignments_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `content_operation_budget_owner_policy_idx` ON `contentOperationBudgetReservations` (`ownerUserId`,`policyId`,`kind`);--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `contentOperationMachineAuthorizations_jobId_seoGeoContentJobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `seoGeoContentJobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMachineAuthorizations` ADD CONSTRAINT `contentOperationMachineAuthorizations_publicationTargetId_contentOperationPublicationTargets_id_fk` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;