CREATE TABLE `learningPublicationActions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`authorizationId` int NOT NULL,
	`entryId` int NOT NULL,
	`attemptId` int NOT NULL,
	`runId` int NOT NULL,
	`targetId` int NOT NULL,
	`draftId` int NOT NULL,
	`draftVersion` int NOT NULL,
	`inputFingerprint` varchar(64) NOT NULL,
	`draftContentHash` varchar(64) NOT NULL,
	`evidenceSnapshotHash` varchar(64) NOT NULL,
	`publicationContentHash` varchar(64) NOT NULL,
	`publicationIdentityFingerprint` varchar(64) NOT NULL,
	`targetConfigurationFingerprint` varchar(64) NOT NULL,
	`publicationUrlHash` varchar(64) NOT NULL,
	`authorizationFingerprint` varchar(64) NOT NULL,
	`sourceFingerprint` varchar(64) NOT NULL,
	`expectedProjection` json,
	`beforeProjection` json,
	`afterProjection` json,
	`plannedAction` json,
	`status` enum('capturing_before','before_ready','dispatch_started','awaiting_after','capturing_after','observed','blocked','expired') NOT NULL DEFAULT 'capturing_before',
	`reasonCode` varchar(80),
	`dispatchStartedAt` timestamp(3),
	`beforeCapturedAt` timestamp(3),
	`deliveredAt` timestamp(3),
	`afterCapturedAt` timestamp(3),
	`nextAttemptAt` timestamp(3),
	`receiptFingerprint` varchar(64),
	`evidenceFingerprint` varchar(64),
	`afterAttemptCount` int NOT NULL DEFAULT 0,
	`leaseToken` varchar(96),
	`leaseVersion` int NOT NULL DEFAULT 0,
	`leaseExpiresAt` timestamp(3),
	`expiresAt` timestamp(3) NOT NULL,
	`reviewStatus` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`reviewFingerprint` varchar(64),
	`reviewEvidenceFingerprint` varchar(64),
	`reviewReasonHash` varchar(64),
	`reviewedAt` timestamp(3),
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `learningPublicationActions_id` PRIMARY KEY(`id`),
	CONSTRAINT `learning_pub_action_owner_attempt_uq` UNIQUE(`ownerUserId`,`attemptId`)
);
--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` MODIFY COLUMN `completedAt` timestamp(3);--> statement-breakpoint
ALTER TABLE `learningPublicationActions` ADD CONSTRAINT `learning_pub_action_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningPublicationActions` ADD CONSTRAINT `learning_pub_action_client_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningPublicationActions` ADD CONSTRAINT `learning_pub_action_auth_fk` FOREIGN KEY (`authorizationId`) REFERENCES `learningSourceAuthorizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningPublicationActions` ADD CONSTRAINT `learning_pub_action_entry_fk` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningPublicationActions` ADD CONSTRAINT `learning_pub_action_attempt_fk` FOREIGN KEY (`attemptId`) REFERENCES `contentOperationPublicationAttempts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningPublicationActions` ADD CONSTRAINT `learning_pub_action_run_fk` FOREIGN KEY (`runId`) REFERENCES `contentOperationRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningPublicationActions` ADD CONSTRAINT `learning_pub_action_target_fk` FOREIGN KEY (`targetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningPublicationActions` ADD CONSTRAINT `learning_pub_action_draft_fk` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `learning_pub_action_due_idx` ON `learningPublicationActions` (`ownerUserId`,`status`,`nextAttemptAt`,`id`);--> statement-breakpoint
CREATE INDEX `learning_pub_action_retention_idx` ON `learningPublicationActions` (`ownerUserId`,`expiresAt`);
