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
CREATE TABLE `managedSiteAiCostLedger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`proposalId` varchar(64),
	`providerKey` varchar(96) NOT NULL,
	`requestUnits` int NOT NULL,
	`inputTokens` int NOT NULL,
	`outputTokens` int NOT NULL,
	`costMicros` int NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteAiCostLedger_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_ai_cost_request_unique` UNIQUE(`ownerUserId`,`projectId`,`requestFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteAiEditProposals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proposalId` varchar(64) NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`pageId` varchar(64) NOT NULL,
	`expectedPageVersion` int NOT NULL,
	`intent` varchar(80) NOT NULL,
	`summary` text NOT NULL,
	`operations` json NOT NULL,
	`diff` json,
	`warnings` json NOT NULL,
	`affectedBlockIds` json NOT NULL,
	`visionMode` enum('metadata_only','injected_provider') NOT NULL DEFAULT 'metadata_only',
	`proposalFingerprint` varchar(128) NOT NULL,
	`status` enum('proposed','clarification_required','approved_to_draft','rejected','expired') NOT NULL DEFAULT 'proposed',
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteAiEditProposals_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_ai_proposal_id_unique` UNIQUE(`proposalId`),
	CONSTRAINT `managed_site_ai_proposal_fingerprint_unique` UNIQUE(`ownerUserId`,`projectId`,`proposalFingerprint`)
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
	`kind` enum('media_processing','media_object_cleanup','scheduled_visibility','orphan_upload_expiry','trash_retention','publish_retry') NOT NULL,
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
CREATE TABLE `managedSiteMediaAssetVersions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetId` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`declaredMime` varchar(160) NOT NULL,
	`sniffedMime` varchar(160),
	`byteSize` int NOT NULL,
	`width` int,
	`height` int,
	`durationMs` int,
	`sha256` varchar(64),
	`processingFingerprint` varchar(128),
	`parentVersionId` int,
	`metadata` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteMediaAssetVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_asset_version_unique` UNIQUE(`assetId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaAssets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`assetId` varchar(64) NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`visibility` enum('public','private','internal') NOT NULL DEFAULT 'private',
	`originalFilename` varchar(255) NOT NULL,
	`mediaType` enum('image') NOT NULL,
	`status` enum('pending_upload','uploaded','quarantined','processing','ready','trashed','deletion_pending','deleted','failed') NOT NULL DEFAULT 'pending_upload',
	`currentVersion` int NOT NULL DEFAULT 1,
	`currentVersionId` int,
	`collectionId` int,
	`createdByUserId` int,
	`createdByAuthority` varchar(160) NOT NULL,
	`rightsMetadata` json NOT NULL,
	`trashedAt` timestamp,
	`retentionUntil` timestamp,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteMediaAssets_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_asset_id_unique` UNIQUE(`assetId`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaCollections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`parentId` int,
	`name` varchar(120) NOT NULL,
	`canonicalKey` varchar(160) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteMediaCollections_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_collection_parent_key_unique` UNIQUE(`projectId`,`parentId`,`canonicalKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetId` varchar(64),
	`uploadId` varchar(64),
	`eventType` varchar(96) NOT NULL,
	`actorAuthority` varchar(160) NOT NULL,
	`beforeFingerprint` varchar(128),
	`afterFingerprint` varchar(128),
	`metadata` json NOT NULL,
	`receiptFingerprint` varchar(128) NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteMediaEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_event_receipt_unique` UNIQUE(`receiptFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaObjects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetVersionId` int NOT NULL,
	`connectionId` int NOT NULL,
	`objectKey` varchar(512) NOT NULL,
	`objectVersionReference` varchar(255),
	`objectKind` enum('original','variant') NOT NULL,
	`byteSize` int NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`deletionReceiptFingerprint` varchar(128),
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteMediaObjects_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_object_version_key_unique` UNIQUE(`connectionId`,`assetVersionId`,`objectKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaProcessingRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetVersionId` int NOT NULL,
	`status` enum('queued','processing','quarantined','retry_wait','failed','succeeded') NOT NULL DEFAULT 'queued',
	`attemptCount` int NOT NULL DEFAULT 0,
	`scannerVerdict` enum('not_configured','pending','passed','blocked','owner_review') NOT NULL DEFAULT 'pending',
	`processingFingerprint` varchar(128) NOT NULL,
	`leaseUntil` timestamp,
	`nextAttemptAt` timestamp,
	`errorCode` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteMediaProcessingRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_processing_fingerprint_unique` UNIQUE(`processingFingerprint`)
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
CREATE TABLE `managedSiteMediaQuotaProjections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`planKey` varchar(96) NOT NULL,
	`maxOriginalBytes` int NOT NULL,
	`maxAssetCount` int NOT NULL,
	`maxMonthlyUploadBytes` int NOT NULL,
	`maxMonthlyProcessingCount` int NOT NULL,
	`originalBytesUsed` int NOT NULL DEFAULT 0,
	`assetCountUsed` int NOT NULL DEFAULT 0,
	`monthlyUploadBytesUsed` int NOT NULL DEFAULT 0,
	`monthlyProcessingCountUsed` int NOT NULL DEFAULT 0,
	`periodKey` varchar(16) NOT NULL,
	`projectionFingerprint` varchar(128) NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteMediaQuotaProjections_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_quota_project_period_unique` UNIQUE(`projectId`,`periodKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaTagLinks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetId` varchar(64) NOT NULL,
	`tagId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteMediaTagLinks_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_tag_link_unique` UNIQUE(`assetId`,`tagId`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaTags` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`name` varchar(80) NOT NULL,
	`canonicalKey` varchar(96) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteMediaTags_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_tag_project_key_unique` UNIQUE(`projectId`,`canonicalKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaUploadSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`uploadId` varchar(64) NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetId` varchar(64) NOT NULL,
	`connectionId` int NOT NULL,
	`objectKey` varchar(512) NOT NULL,
	`originalFilename` varchar(255) NOT NULL,
	`visibility` enum('public','private','internal') NOT NULL DEFAULT 'private',
	`declaredMime` varchar(160) NOT NULL,
	`declaredBytes` int NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`status` enum('issued','uploading','uploaded','completing','completed','expired','cancelled','rejected') NOT NULL DEFAULT 'issued',
	`completionFingerprint` varchar(128),
	`quotaOriginalBytesCommitted` int NOT NULL DEFAULT 0,
	`quotaAssetCountCommitted` int NOT NULL DEFAULT 0,
	`expiresAt` timestamp NOT NULL,
	`leaseUntil` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteMediaUploadSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_upload_id_unique` UNIQUE(`uploadId`),
	CONSTRAINT `managed_site_media_upload_idempotency_unique` UNIQUE(`ownerUserId`,`projectId`,`idempotencyKey`),
	CONSTRAINT `managed_site_media_upload_request_unique` UNIQUE(`ownerUserId`,`projectId`,`requestFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaUsageBindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetId` varchar(64) NOT NULL,
	`assetVersion` int NOT NULL,
	`assetSha256` varchar(64) NOT NULL,
	`pageId` varchar(64) NOT NULL,
	`pageVersion` int NOT NULL,
	`blockId` varchar(64) NOT NULL,
	`role` varchar(80) NOT NULL,
	`bindingFingerprint` varchar(128) NOT NULL,
	`releasedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteMediaUsageBindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_usage_fingerprint_unique` UNIQUE(`bindingFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMediaVariants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetVersionId` int NOT NULL,
	`mediaObjectId` int NOT NULL,
	`variantKey` varchar(96) NOT NULL,
	`format` enum('jpeg','png','webp','avif') NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`byteSize` int NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`transformation` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteMediaVariants_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_media_variant_identity_unique` UNIQUE(`assetVersionId`,`variantKey`,`format`)
);
--> statement-breakpoint
CREATE TABLE `managedSitePageOperations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`pageId` varchar(64) NOT NULL,
	`fromVersion` int NOT NULL,
	`toVersion` int NOT NULL,
	`commandType` varchar(80) NOT NULL,
	`command` json NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`actorAuthority` varchar(160) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSitePageOperations_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_page_operation_idempotency_unique` UNIQUE(`ownerUserId`,`projectId`,`idempotencyKey`),
	CONSTRAINT `managed_site_page_operation_request_unique` UNIQUE(`ownerUserId`,`projectId`,`requestFingerprint`)
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
CREATE TABLE `managedSitePagePublicationReceipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`pageId` varchar(64) NOT NULL,
	`pageVersion` int NOT NULL,
	`releaseId` int,
	`publicationTargetId` int,
	`status` enum('intent_created','publishing','succeeded','failed','rollback_pending','rolled_back') NOT NULL DEFAULT 'intent_created',
	`artifactFingerprint` varchar(128) NOT NULL,
	`mediaSetFingerprint` varchar(128) NOT NULL,
	`receiptFingerprint` varchar(128) NOT NULL,
	`providerReceiptReference` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSitePagePublicationReceipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_page_publish_receipt_unique` UNIQUE(`receiptFingerprint`)
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
CREATE TABLE `managedSitePageVersions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`pageId` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`parentVersion` int,
	`document` json NOT NULL,
	`documentFingerprint` varchar(128) NOT NULL,
	`lifecycleStatus` enum('draft','preview','published','superseded','rolled_back','archived') NOT NULL DEFAULT 'draft',
	`actorAuthority` varchar(160) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSitePageVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_page_version_unique` UNIQUE(`pageId`,`version`),
	CONSTRAINT `managed_site_page_fingerprint_unique` UNIQUE(`pageId`,`documentFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSitePages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pageId` varchar(64) NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`locale` varchar(20) NOT NULL,
	`route` varchar(512) NOT NULL,
	`contentType` varchar(80) NOT NULL,
	`currentDraftVersion` int NOT NULL DEFAULT 0,
	`publishedVersion` int NOT NULL DEFAULT 0,
	`status` enum('draft','preview','publishing','published','failed','archived') NOT NULL DEFAULT 'draft',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSitePages_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_page_id_unique` UNIQUE(`pageId`),
	CONSTRAINT `managed_site_page_route_unique` UNIQUE(`projectId`,`locale`,`route`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteStorageConnections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`providerKey` enum('s3_compatible','local_dev','memory_test') NOT NULL,
	`credentialReference` varchar(160),
	`configuration` json NOT NULL,
	`configurationFingerprint` varchar(128) NOT NULL,
	`status` enum('disabled','mock','configured','verified','blocked') NOT NULL DEFAULT 'disabled',
	`healthReceiptFingerprint` varchar(128),
	`scannerAuthorityFingerprint` varchar(128),
	`scannerHealthReceiptFingerprint` varchar(128),
	`scannerVerifiedAt` timestamp,
	`verifiedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteStorageConnections_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_storage_project_unique` UNIQUE(`projectId`),
	CONSTRAINT `managed_site_storage_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`configurationFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteAiBudgetBuckets` ADD CONSTRAINT `managedSiteAiBudgetBuckets_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiBudgetBuckets` ADD CONSTRAINT `managedSiteAiBudgetBuckets_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiBudgetClaims` ADD CONSTRAINT `managedSiteAiBudgetClaims_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiBudgetClaims` ADD CONSTRAINT `managedSiteAiBudgetClaims_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiCostLedger` ADD CONSTRAINT `managedSiteAiCostLedger_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiCostLedger` ADD CONSTRAINT `managedSiteAiCostLedger_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiEditProposals` ADD CONSTRAINT `managedSiteAiEditProposals_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiEditProposals` ADD CONSTRAINT `managedSiteAiEditProposals_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteEditorJobReceipts` ADD CONSTRAINT `managedSiteEditorJobReceipts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteEditorJobReceipts` ADD CONSTRAINT `managedSiteEditorJobReceipts_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteEditorJobs` ADD CONSTRAINT `managedSiteEditorJobs_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteEditorJobs` ADD CONSTRAINT `managedSiteEditorJobs_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssetVersions` ADD CONSTRAINT `managedSiteMediaAssetVersions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssetVersions` ADD CONSTRAINT `fk_managed_site_media_asset_project_id_c9d1d6836b` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssets` ADD CONSTRAINT `managedSiteMediaAssets_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssets` ADD CONSTRAINT `managedSiteMediaAssets_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssets` ADD CONSTRAINT `managedSiteMediaAssets_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaCollections` ADD CONSTRAINT `managedSiteMediaCollections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaCollections` ADD CONSTRAINT `managedSiteMediaCollections_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaEvents` ADD CONSTRAINT `managedSiteMediaEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaEvents` ADD CONSTRAINT `managedSiteMediaEvents_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaObjects` ADD CONSTRAINT `managedSiteMediaObjects_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaObjects` ADD CONSTRAINT `managedSiteMediaObjects_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaObjects` ADD CONSTRAINT `fk_managed_site_media_objec_asset_version_id_5949ee9b63` FOREIGN KEY (`assetVersionId`) REFERENCES `managedSiteMediaAssetVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaObjects` ADD CONSTRAINT `fk_managed_site_media_objec_connection_id_f71b3acea5` FOREIGN KEY (`connectionId`) REFERENCES `managedSiteStorageConnections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaProcessingRuns` ADD CONSTRAINT `managedSiteMediaProcessingRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaProcessingRuns` ADD CONSTRAINT `fk_managed_site_media_proce_project_id_81f7b4aea5` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaProcessingRuns` ADD CONSTRAINT `fk_managed_site_media_proce_asset_version_id_16e118f3bc` FOREIGN KEY (`assetVersionId`) REFERENCES `managedSiteMediaAssetVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaQuotaClaims` ADD CONSTRAINT `managedSiteMediaQuotaClaims_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaQuotaClaims` ADD CONSTRAINT `managedSiteMediaQuotaClaims_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaQuotaProjections` ADD CONSTRAINT `managedSiteMediaQuotaProjections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaQuotaProjections` ADD CONSTRAINT `fk_managed_site_media_quota_project_id_07b5aa9438` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTagLinks` ADD CONSTRAINT `managedSiteMediaTagLinks_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTagLinks` ADD CONSTRAINT `managedSiteMediaTagLinks_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTagLinks` ADD CONSTRAINT `managedSiteMediaTagLinks_tagId_managedSiteMediaTags_id_fk` FOREIGN KEY (`tagId`) REFERENCES `managedSiteMediaTags`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTags` ADD CONSTRAINT `managedSiteMediaTags_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTags` ADD CONSTRAINT `managedSiteMediaTags_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUploadSessions` ADD CONSTRAINT `managedSiteMediaUploadSessions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUploadSessions` ADD CONSTRAINT `fk_managed_site_media_uploa_project_id_53418513b0` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUploadSessions` ADD CONSTRAINT `fk_managed_site_media_uploa_connection_id_9efa170fb5` FOREIGN KEY (`connectionId`) REFERENCES `managedSiteStorageConnections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUsageBindings` ADD CONSTRAINT `managedSiteMediaUsageBindings_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUsageBindings` ADD CONSTRAINT `fk_managed_site_media_usage_project_id_01b6041018` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaVariants` ADD CONSTRAINT `managedSiteMediaVariants_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaVariants` ADD CONSTRAINT `managedSiteMediaVariants_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaVariants` ADD CONSTRAINT `fk_managed_site_media_varia_asset_version_id_e06841b368` FOREIGN KEY (`assetVersionId`) REFERENCES `managedSiteMediaAssetVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaVariants` ADD CONSTRAINT `fk_managed_site_media_varia_media_object_id_f5cdd7ea37` FOREIGN KEY (`mediaObjectId`) REFERENCES `managedSiteMediaObjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePageOperations` ADD CONSTRAINT `managedSitePageOperations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePageOperations` ADD CONSTRAINT `managedSitePageOperations_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationAttempts` ADD CONSTRAINT `fk_managed_site_page_public_work_id_437b841d3d` FOREIGN KEY (`workId`) REFERENCES `managedSitePagePublicationWorks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationAttempts` ADD CONSTRAINT `managedSitePagePublicationAttempts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationAttempts` ADD CONSTRAINT `fk_managed_site_page_public_project_id_1d80a8b0aa` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationAttempts` ADD CONSTRAINT `fk_managed_site_page_public_publication_target_92a78cd79f` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationReceipts` ADD CONSTRAINT `managedSitePagePublicationReceipts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationReceipts` ADD CONSTRAINT `fk_managed_site_page_public_project_id_156a1483ee` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationReceipts` ADD CONSTRAINT `fk_managed_site_page_public_publication_target_23788a7bcd` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationWorks` ADD CONSTRAINT `managedSitePagePublicationWorks_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationWorks` ADD CONSTRAINT `fk_managed_site_page_public_project_id_12233959f0` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationWorks` ADD CONSTRAINT `fk_managed_site_page_public_client_id_6311fc6c45` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationWorks` ADD CONSTRAINT `fk_managed_site_page_public_publication_target_8b10a9bd09` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePageVersions` ADD CONSTRAINT `managedSitePageVersions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePageVersions` ADD CONSTRAINT `managedSitePageVersions_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePages` ADD CONSTRAINT `managedSitePages_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePages` ADD CONSTRAINT `managedSitePages_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteStorageConnections` ADD CONSTRAINT `managedSiteStorageConnections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteStorageConnections` ADD CONSTRAINT `fk_managed_site_storage_con_project_id_cfe6906220` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_ai_budget_claim_status_idx` ON `managedSiteAiBudgetClaims` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_ai_cost_tenant_time_idx` ON `managedSiteAiCostLedger` (`ownerUserId`,`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_editor_job_receipt_job_idx` ON `managedSiteEditorJobReceipts` (`jobId`,`attemptNumber`);--> statement-breakpoint
CREATE INDEX `managed_site_editor_job_due_idx` ON `managedSiteEditorJobs` (`status`,`availableAt`,`leaseUntil`);--> statement-breakpoint
CREATE INDEX `managed_site_editor_job_tenant_idx` ON `managedSiteEditorJobs` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_media_version_tenant_hash_idx` ON `managedSiteMediaAssetVersions` (`ownerUserId`,`projectId`,`sha256`);--> statement-breakpoint
CREATE INDEX `managed_site_media_owner_project_status_idx` ON `managedSiteMediaAssets` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_media_asset_tenant_page_idx` ON `managedSiteMediaAssets` (`ownerUserId`,`projectId`,`deletedAt`,`createdAt`,`assetId`);--> statement-breakpoint
CREATE INDEX `managed_site_media_event_tenant_time_idx` ON `managedSiteMediaEvents` (`ownerUserId`,`projectId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `managed_site_media_event_asset_type_idx` ON `managedSiteMediaEvents` (`ownerUserId`,`projectId`,`assetId`,`eventType`);--> statement-breakpoint
CREATE INDEX `managed_site_media_object_tenant_version_idx` ON `managedSiteMediaObjects` (`ownerUserId`,`projectId`,`assetVersionId`);--> statement-breakpoint
CREATE INDEX `managed_site_media_processing_status_idx` ON `managedSiteMediaProcessingRuns` (`status`,`nextAttemptAt`);--> statement-breakpoint
CREATE INDEX `managed_site_media_quota_claim_status_idx` ON `managedSiteMediaQuotaClaims` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_media_upload_asset_status_idx` ON `managedSiteMediaUploadSessions` (`ownerUserId`,`projectId`,`assetId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_media_usage_asset_idx` ON `managedSiteMediaUsageBindings` (`ownerUserId`,`projectId`,`assetId`,`releasedAt`);--> statement-breakpoint
CREATE INDEX `managed_site_page_publish_status_idx` ON `managedSitePagePublicationReceipts` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_page_publish_work_due_idx` ON `managedSitePagePublicationWorks` (`status`,`availableAt`,`leaseUntil`);--> statement-breakpoint
CREATE INDEX `managed_site_page_publish_work_tenant_idx` ON `managedSitePagePublicationWorks` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_page_tenant_route_idx` ON `managedSitePages` (`ownerUserId`,`projectId`,`route`,`pageId`);