CREATE TABLE `managedSiteAiBudgetBuckets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`dayKey` varchar(16) NOT NULL,
	`maxRequests` int NOT NULL,
	`maxInputTokens` int NOT NULL,
	`maxCostMicros` int NOT NULL,
	`requestsReserved` int NOT NULL DEFAULT 0,
	`inputTokensReserved` int NOT NULL DEFAULT 0,
	`costMicrosReserved` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteAiBudgetBuckets_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_ai_budget_bucket_unique` UNIQUE(`ownerUserId`,`projectId`,`dayKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteAiBudgetClaims` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`dayKey` varchar(16) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`requests` int NOT NULL,
	`inputTokens` int NOT NULL,
	`costMicros` int NOT NULL,
	`status` enum('reserved','committed','released') NOT NULL DEFAULT 'reserved',
	`proposalId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteAiBudgetClaims_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_ai_budget_claim_unique` UNIQUE(`ownerUserId`,`projectId`,`dayKey`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteEditorJobReceipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` varchar(96) NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`attemptNumber` int NOT NULL,
	`status` enum('succeeded','retry_wait','blocked') NOT NULL,
	`outcome` varchar(160) NOT NULL,
	`reasonCode` varchar(120),
	`receiptFingerprint` varchar(128) NOT NULL,
	`metadata` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteEditorJobReceipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_editor_job_receipt_unique` UNIQUE(`receiptFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteEditorJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` varchar(96) NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`kind` enum('media_processing','scheduled_visibility','orphan_upload_expiry','trash_retention','publish_retry') NOT NULL,
	`sourceReference` varchar(160) NOT NULL,
	`stateFingerprint` varchar(128) NOT NULL,
	`payload` json NOT NULL,
	`status` enum('queued','leased','retry_wait','succeeded','blocked') NOT NULL DEFAULT 'queued',
	`attemptCount` int NOT NULL DEFAULT 0,
	`maxAttempts` int NOT NULL DEFAULT 5,
	`availableAt` timestamp NOT NULL DEFAULT (now()),
	`leaseOwner` varchar(128),
	`leaseUntil` timestamp,
	`lastErrorCode` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteEditorJobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_editor_job_identity_unique` UNIQUE(`jobId`),
	CONSTRAINT `managed_site_editor_job_source_unique` UNIQUE(`kind`,`sourceReference`,`stateFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaQuotaClaims` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`periodKey` varchar(16) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`claimKind` enum('reservation','credit') NOT NULL DEFAULT 'reservation',
	`originalBytes` int NOT NULL DEFAULT 0,
	`assetCount` int NOT NULL DEFAULT 0,
	`uploadBytes` int NOT NULL DEFAULT 0,
	`processingCount` int NOT NULL DEFAULT 0,
	`status` enum('reserved','committed','released') NOT NULL DEFAULT 'reserved',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteMediaQuotaClaims_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_quota_claim_idempotency_unique` UNIQUE(`ownerUserId`,`projectId`,`periodKey`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSitePagePublicationAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workId` int NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`publicationTargetId` int NOT NULL,
	`attemptNumber` int NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`status` enum('delivered','retryable_failure','permanent_failure','blocked') NOT NULL,
	`receiptFingerprint` varchar(128) NOT NULL,
	`remoteRevision` varchar(256),
	`remoteState` varchar(64),
	`errorCode` varchar(120),
	`result` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSitePagePublicationAttempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_page_publish_attempt_number_unique` UNIQUE(`workId`,`attemptNumber`),
	CONSTRAINT `managed_site_page_publish_attempt_receipt_unique` UNIQUE(`receiptFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSitePagePublicationWorks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`clientId` int NOT NULL,
	`pageId` varchar(64) NOT NULL,
	`pageVersion` int NOT NULL,
	`releaseId` int NOT NULL,
	`publicationTargetId` int NOT NULL,
	`operationKind` enum('publish','rollback') NOT NULL DEFAULT 'publish',
	`artifact` json NOT NULL,
	`artifactBytes` int NOT NULL,
	`artifactFingerprint` varchar(128) NOT NULL,
	`mediaSetFingerprint` varchar(128) NOT NULL,
	`pageFingerprint` varchar(128) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`status` enum('queued','leased','retry_wait','succeeded','blocked') NOT NULL DEFAULT 'queued',
	`attemptCount` int NOT NULL DEFAULT 0,
	`maxAttempts` int NOT NULL DEFAULT 5,
	`availableAt` timestamp NOT NULL DEFAULT (now()),
	`leaseOwner` varchar(128),
	`leaseUntil` timestamp,
	`lastErrorCode` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSitePagePublicationWorks_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_page_publish_work_idempotency_unique` UNIQUE(`ownerUserId`,`projectId`,`publicationTargetId`,`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteMediaUploadSessions` ADD `quotaOriginalBytesCommitted` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUploadSessions` ADD `quotaAssetCountCommitted` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSiteStorageConnections` ADD `healthReceiptFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `managedSiteStorageConnections` ADD `scannerAuthorityFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `managedSiteStorageConnections` ADD `scannerHealthReceiptFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `managedSiteStorageConnections` ADD `scannerVerifiedAt` timestamp;--> statement-breakpoint
ALTER TABLE `managedSiteAiBudgetBuckets` ADD CONSTRAINT `managedSiteAiBudgetBuckets_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiBudgetBuckets` ADD CONSTRAINT `managedSiteAiBudgetBuckets_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiBudgetClaims` ADD CONSTRAINT `managedSiteAiBudgetClaims_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiBudgetClaims` ADD CONSTRAINT `managedSiteAiBudgetClaims_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteEditorJobReceipts` ADD CONSTRAINT `managedSiteEditorJobReceipts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteEditorJobReceipts` ADD CONSTRAINT `managedSiteEditorJobReceipts_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteEditorJobs` ADD CONSTRAINT `managedSiteEditorJobs_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteEditorJobs` ADD CONSTRAINT `managedSiteEditorJobs_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaQuotaClaims` ADD CONSTRAINT `managedSiteMediaQuotaClaims_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaQuotaClaims` ADD CONSTRAINT `managedSiteMediaQuotaClaims_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationAttempts` ADD CONSTRAINT `managedSitePagePublicationAttempts_workId_managedSitePagePublicationWorks_id_fk` FOREIGN KEY (`workId`) REFERENCES `managedSitePagePublicationWorks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationAttempts` ADD CONSTRAINT `managedSitePagePublicationAttempts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationAttempts` ADD CONSTRAINT `managedSitePagePublicationAttempts_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationAttempts` ADD CONSTRAINT `managedSitePagePublicationAttempts_publicationTargetId_contentOperationPublicationTargets_id_fk` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationWorks` ADD CONSTRAINT `managedSitePagePublicationWorks_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationWorks` ADD CONSTRAINT `managedSitePagePublicationWorks_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationWorks` ADD CONSTRAINT `managedSitePagePublicationWorks_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationWorks` ADD CONSTRAINT `managedSitePagePublicationWorks_publicationTargetId_contentOperationPublicationTargets_id_fk` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_ai_budget_claim_status_idx` ON `managedSiteAiBudgetClaims` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_editor_job_receipt_job_idx` ON `managedSiteEditorJobReceipts` (`jobId`,`attemptNumber`);--> statement-breakpoint
CREATE INDEX `managed_site_editor_job_due_idx` ON `managedSiteEditorJobs` (`status`,`availableAt`,`leaseUntil`);--> statement-breakpoint
CREATE INDEX `managed_site_editor_job_tenant_idx` ON `managedSiteEditorJobs` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_media_quota_claim_status_idx` ON `managedSiteMediaQuotaClaims` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_page_publish_work_due_idx` ON `managedSitePagePublicationWorks` (`status`,`availableAt`,`leaseUntil`);--> statement-breakpoint
CREATE INDEX `managed_site_page_publish_work_tenant_idx` ON `managedSitePagePublicationWorks` (`ownerUserId`,`projectId`,`status`);