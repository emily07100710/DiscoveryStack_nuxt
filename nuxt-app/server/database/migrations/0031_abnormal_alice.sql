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
	CONSTRAINT `managed_site_media_object_key_unique` UNIQUE(`connectionId`,`objectKey`)
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
	`verifiedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteStorageConnections_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_storage_project_unique` UNIQUE(`projectId`),
	CONSTRAINT `managed_site_storage_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`configurationFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteAiCostLedger` ADD CONSTRAINT `managedSiteAiCostLedger_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiCostLedger` ADD CONSTRAINT `managedSiteAiCostLedger_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiEditProposals` ADD CONSTRAINT `managedSiteAiEditProposals_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAiEditProposals` ADD CONSTRAINT `managedSiteAiEditProposals_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssetVersions` ADD CONSTRAINT `managedSiteMediaAssetVersions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssetVersions` ADD CONSTRAINT `managedSiteMediaAssetVersions_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssets` ADD CONSTRAINT `managedSiteMediaAssets_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssets` ADD CONSTRAINT `managedSiteMediaAssets_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaAssets` ADD CONSTRAINT `managedSiteMediaAssets_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaCollections` ADD CONSTRAINT `managedSiteMediaCollections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaCollections` ADD CONSTRAINT `managedSiteMediaCollections_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaEvents` ADD CONSTRAINT `managedSiteMediaEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaEvents` ADD CONSTRAINT `managedSiteMediaEvents_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaObjects` ADD CONSTRAINT `managedSiteMediaObjects_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaObjects` ADD CONSTRAINT `managedSiteMediaObjects_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaObjects` ADD CONSTRAINT `managedSiteMediaObjects_assetVersionId_managedSiteMediaAssetVersions_id_fk` FOREIGN KEY (`assetVersionId`) REFERENCES `managedSiteMediaAssetVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaObjects` ADD CONSTRAINT `managedSiteMediaObjects_connectionId_managedSiteStorageConnections_id_fk` FOREIGN KEY (`connectionId`) REFERENCES `managedSiteStorageConnections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaProcessingRuns` ADD CONSTRAINT `managedSiteMediaProcessingRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaProcessingRuns` ADD CONSTRAINT `managedSiteMediaProcessingRuns_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaProcessingRuns` ADD CONSTRAINT `managedSiteMediaProcessingRuns_assetVersionId_managedSiteMediaAssetVersions_id_fk` FOREIGN KEY (`assetVersionId`) REFERENCES `managedSiteMediaAssetVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaQuotaProjections` ADD CONSTRAINT `managedSiteMediaQuotaProjections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaQuotaProjections` ADD CONSTRAINT `managedSiteMediaQuotaProjections_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTagLinks` ADD CONSTRAINT `managedSiteMediaTagLinks_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTagLinks` ADD CONSTRAINT `managedSiteMediaTagLinks_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTagLinks` ADD CONSTRAINT `managedSiteMediaTagLinks_tagId_managedSiteMediaTags_id_fk` FOREIGN KEY (`tagId`) REFERENCES `managedSiteMediaTags`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTags` ADD CONSTRAINT `managedSiteMediaTags_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaTags` ADD CONSTRAINT `managedSiteMediaTags_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUploadSessions` ADD CONSTRAINT `managedSiteMediaUploadSessions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUploadSessions` ADD CONSTRAINT `managedSiteMediaUploadSessions_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUploadSessions` ADD CONSTRAINT `managedSiteMediaUploadSessions_connectionId_managedSiteStorageConnections_id_fk` FOREIGN KEY (`connectionId`) REFERENCES `managedSiteStorageConnections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUsageBindings` ADD CONSTRAINT `managedSiteMediaUsageBindings_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaUsageBindings` ADD CONSTRAINT `managedSiteMediaUsageBindings_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaVariants` ADD CONSTRAINT `managedSiteMediaVariants_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaVariants` ADD CONSTRAINT `managedSiteMediaVariants_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaVariants` ADD CONSTRAINT `managedSiteMediaVariants_assetVersionId_managedSiteMediaAssetVersions_id_fk` FOREIGN KEY (`assetVersionId`) REFERENCES `managedSiteMediaAssetVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMediaVariants` ADD CONSTRAINT `managedSiteMediaVariants_mediaObjectId_managedSiteMediaObjects_id_fk` FOREIGN KEY (`mediaObjectId`) REFERENCES `managedSiteMediaObjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePageOperations` ADD CONSTRAINT `managedSitePageOperations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePageOperations` ADD CONSTRAINT `managedSitePageOperations_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationReceipts` ADD CONSTRAINT `managedSitePagePublicationReceipts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationReceipts` ADD CONSTRAINT `managedSitePagePublicationReceipts_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePagePublicationReceipts` ADD CONSTRAINT `managedSitePagePublicationReceipts_publicationTargetId_contentOperationPublicationTargets_id_fk` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePageVersions` ADD CONSTRAINT `managedSitePageVersions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePageVersions` ADD CONSTRAINT `managedSitePageVersions_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePages` ADD CONSTRAINT `managedSitePages_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePages` ADD CONSTRAINT `managedSitePages_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteStorageConnections` ADD CONSTRAINT `managedSiteStorageConnections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteStorageConnections` ADD CONSTRAINT `managedSiteStorageConnections_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_ai_cost_tenant_time_idx` ON `managedSiteAiCostLedger` (`ownerUserId`,`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_media_version_tenant_hash_idx` ON `managedSiteMediaAssetVersions` (`ownerUserId`,`projectId`,`sha256`);--> statement-breakpoint
CREATE INDEX `managed_site_media_owner_project_status_idx` ON `managedSiteMediaAssets` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_media_event_tenant_time_idx` ON `managedSiteMediaEvents` (`ownerUserId`,`projectId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `managed_site_media_object_tenant_version_idx` ON `managedSiteMediaObjects` (`ownerUserId`,`projectId`,`assetVersionId`);--> statement-breakpoint
CREATE INDEX `managed_site_media_processing_status_idx` ON `managedSiteMediaProcessingRuns` (`status`,`nextAttemptAt`);--> statement-breakpoint
CREATE INDEX `managed_site_media_usage_asset_idx` ON `managedSiteMediaUsageBindings` (`ownerUserId`,`projectId`,`assetId`,`releasedAt`);--> statement-breakpoint
CREATE INDEX `managed_site_page_publish_status_idx` ON `managedSitePagePublicationReceipts` (`ownerUserId`,`projectId`,`status`);