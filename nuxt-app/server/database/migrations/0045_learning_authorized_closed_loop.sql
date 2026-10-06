CREATE TABLE `learningEvidenceCollections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`authorizationId` int NOT NULL,
	`clientId` int NOT NULL,
	`sourceId` int NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(64) NOT NULL,
	`authorizationFingerprint` varchar(64) NOT NULL,
	`status` enum('collecting','completed','failed') NOT NULL,
	`projection` json,
	`projectionFingerprint` varchar(64),
	`reviewStatus` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`reviewFingerprint` varchar(64),
	`reviewedAt` timestamp,
	`retentionUntil` timestamp NOT NULL,
	`leaseToken` varchar(64),
	`leaseVersion` int NOT NULL DEFAULT 1,
	`leaseExpiresAt` timestamp,
	`errorCode` varchar(80),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `learningEvidenceCollections_id` PRIMARY KEY(`id`),
	CONSTRAINT `learning_collect_owner_key_uq` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `learningOutcomeModels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`datasetDigest` varchar(64) NOT NULL,
	`lineageFingerprint` varchar(64) NOT NULL,
	`dataReviewFingerprint` varchar(64) NOT NULL,
	`reviewReasonHash` varchar(64) NOT NULL,
	`candidateCount` int NOT NULL,
	`candidateFingerprints` json NOT NULL,
	`candidateLineage` json NOT NULL,
	`status` enum('queued','training','completed','blocked','revoked') NOT NULL DEFAULT 'queued',
	`approvedAt` timestamp NOT NULL,
	`artifact` json,
	`artifactHash` varchar(64),
	`metrics` json,
	`reasonCode` varchar(80),
	`leaseToken` varchar(64),
	`leaseVersion` int NOT NULL DEFAULT 0,
	`leaseExpiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`revokedAt` timestamp,
	CONSTRAINT `learningOutcomeModels_id` PRIMARY KEY(`id`),
	CONSTRAINT `learning_effect_owner_release_uq` UNIQUE(`ownerUserId`,`datasetDigest`,`lineageFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `learningSourceAuthorizations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`sourceId` int NOT NULL,
	`authorizedOrigin` varchar(2048) NOT NULL,
	`rightsBasis` enum('owner_authorized','licensed','open_license_verified') NOT NULL,
	`rightsEvidenceHash` varchar(64) NOT NULL,
	`consentVersion` varchar(80) NOT NULL,
	`consentReceiptHash` varchar(64) NOT NULL,
	`authorizationFingerprint` varchar(64) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`status` enum('active','revoked') NOT NULL,
	`retentionDays` int NOT NULL,
	`approvedAt` timestamp NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `learningSourceAuthorizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `learning_auth_owner_key_uq` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `learningEvidenceCollections` ADD CONSTRAINT `learning_collect_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningEvidenceCollections` ADD CONSTRAINT `learning_collect_authorization_fk` FOREIGN KEY (`authorizationId`) REFERENCES `learningSourceAuthorizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningEvidenceCollections` ADD CONSTRAINT `learning_collect_client_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningEvidenceCollections` ADD CONSTRAINT `learning_collect_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningOutcomeModels` ADD CONSTRAINT `learning_effect_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningSourceAuthorizations` ADD CONSTRAINT `learning_auth_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningSourceAuthorizations` ADD CONSTRAINT `learning_auth_client_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learningSourceAuthorizations` ADD CONSTRAINT `learning_auth_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `learning_collect_scope_idx` ON `learningEvidenceCollections` (`ownerUserId`,`clientId`,`status`);--> statement-breakpoint
CREATE INDEX `learning_collect_retention_idx` ON `learningEvidenceCollections` (`retentionUntil`);--> statement-breakpoint
CREATE INDEX `learning_effect_queue_idx` ON `learningOutcomeModels` (`ownerUserId`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `learning_auth_scope_idx` ON `learningSourceAuthorizations` (`ownerUserId`,`clientId`,`sourceId`,`status`);