CREATE TABLE `contentOperationPublicationAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`entryId` int NOT NULL,
	`runId` int NOT NULL,
	`targetId` int NOT NULL,
	`attemptNumber` int NOT NULL,
	`mode` enum('dry_run','execute') NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`publicationId` varchar(160) NOT NULL,
	`publicationSlug` varchar(160) NOT NULL,
	`publicationPath` varchar(512) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`artifactFingerprint` varchar(128),
	`status` enum('planned','dry_run_succeeded','delivered','retryable_failure','permanent_failure','blocked') NOT NULL,
	`remoteState` varchar(64),
	`remoteRevision` varchar(256),
	`errorCode` varchar(120),
	`errorSummary` varchar(500),
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationPublicationAttempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_attempts_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationPublicationTargets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`targetId` varchar(128) NOT NULL,
	`framework` enum('astro','nuxt') NOT NULL,
	`transport` enum('first_party_git','first_party_signed_api') NOT NULL,
	`targetOrigin` varchar(2048) NOT NULL,
	`contentRoot` varchar(256) NOT NULL,
	`defaultBranch` varchar(128),
	`repositoryOwner` varchar(100),
	`repositoryName` varchar(100),
	`endpointPath` varchar(256),
	`credentialReference` varchar(128) NOT NULL,
	`allowedContentTypes` json NOT NULL,
	`allowedLanguages` json NOT NULL,
	`maximumPayloadBytes` int NOT NULL,
	`status` enum('active','paused','revoked') NOT NULL DEFAULT 'active',
	`executionEnabled` boolean NOT NULL DEFAULT false,
	`configurationFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`revokedAt` timestamp,
	CONSTRAINT `contentOperationPublicationTargets_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_targets_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `content_operation_targets_owner_target_unique` UNIQUE(`ownerUserId`,`targetId`)
);
--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `publicationTargetId` int;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `publicationSlug` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `publicationPath` varchar(512);--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `publicationIdentityFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD CONSTRAINT `contentOperationPublicationAttempts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD CONSTRAINT `contentOperationPublicationAttempts_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD CONSTRAINT `contentOperationPublicationAttempts_entryId_contentOperationCalendarEntries_id_fk` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD CONSTRAINT `contentOperationPublicationAttempts_runId_contentOperationRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `contentOperationRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD CONSTRAINT `contentOperationPublicationAttempts_targetId_contentOperationPublicationTargets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` ADD CONSTRAINT `contentOperationPublicationTargets_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` ADD CONSTRAINT `contentOperationPublicationTargets_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `content_operation_attempts_owner_entry_idx` ON `contentOperationPublicationAttempts` (`ownerUserId`,`entryId`);--> statement-breakpoint
CREATE INDEX `content_operation_attempts_owner_status_idx` ON `contentOperationPublicationAttempts` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `content_operation_attempts_run_idx` ON `contentOperationPublicationAttempts` (`runId`);--> statement-breakpoint
CREATE INDEX `content_operation_attempts_target_idx` ON `contentOperationPublicationAttempts` (`targetId`);--> statement-breakpoint
CREATE INDEX `content_operation_targets_owner_client_status_idx` ON `contentOperationPublicationTargets` (`ownerUserId`,`clientId`,`status`);--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `contentOperationCalendarEntries_publicationTargetId_contentOperationPublicationTargets_id_fk` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;