CREATE TABLE `managedSiteConnectorAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int,
	`draftOrderId` int,
	`releaseId` int,
	`capability` enum('website_generator','payment','domain_registration','dns_tls','deployment') NOT NULL,
	`operation` varchar(120) NOT NULL,
	`executionMode` enum('dry_run','mocked','live') NOT NULL,
	`status` enum('queued','processing','retry_wait','blocked','failed','succeeded') NOT NULL DEFAULT 'queued',
	`attemptNumber` int NOT NULL DEFAULT 0,
	`maxAttempts` int NOT NULL DEFAULT 3,
	`timeoutMs` int NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`retryEligibleAt` timestamp,
	`exactResponseIdentity` varchar(256),
	`errorCode` varchar(120),
	`errorSummary` varchar(500),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteConnectorAttempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_connector_attempt_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `managed_site_connector_attempt_owner_request_unique` UNIQUE(`ownerUserId`,`requestFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteConnectorReceipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int,
	`draftOrderId` int,
	`releaseId` int,
	`attemptId` int,
	`capability` enum('website_generator','payment','domain_registration','dns_tls','deployment') NOT NULL,
	`providerKey` varchar(96) NOT NULL,
	`providerEventId` varchar(160) NOT NULL,
	`receiptType` varchar(120) NOT NULL,
	`receiptStatus` enum('verified','ignored_out_of_order','replayed','rejected') NOT NULL,
	`externalReference` varchar(160),
	`exactResponseIdentity` varchar(256) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`contentHash` varchar(128),
	`canonicalDomain` varchar(253),
	`metadata` json NOT NULL,
	`receiptFingerprint` varchar(128) NOT NULL,
	`verifiedAt` timestamp NOT NULL,
	CONSTRAINT `managedSiteConnectorReceipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_connector_receipt_provider_event_unique` UNIQUE(`providerKey`,`providerEventId`),
	CONSTRAINT `managed_site_connector_receipt_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`receiptFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteGenerationCandidates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`sourceVersionId` int NOT NULL,
	`requestSchemaVersion` varchar(96) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`providerKey` varchar(96) NOT NULL,
	`providerModel` varchar(128) NOT NULL,
	`providerRequestId` varchar(160) NOT NULL,
	`manifest` json NOT NULL,
	`manifestHash` varchar(128) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`vaultReference` varchar(512) NOT NULL,
	`gateSummary` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteGenerationCandidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_generation_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `managed_site_generation_owner_request_unique` UNIQUE(`ownerUserId`,`requestFingerprint`),
	CONSTRAINT `managed_site_generation_provider_request_unique` UNIQUE(`providerKey`,`providerRequestId`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteProviderConfigurations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`capability` enum('website_generator','payment','domain_registration','dns_tls','deployment') NOT NULL,
	`providerKey` varchar(96) NOT NULL,
	`readinessStatus` enum('disabled','mock','configured','verified','blocked') NOT NULL DEFAULT 'disabled',
	`credentialReference` varchar(160),
	`transportConfiguration` json NOT NULL,
	`configurationFingerprint` varchar(128) NOT NULL,
	`verificationReceiptFingerprint` varchar(128),
	`blockedReasonCode` varchar(120),
	`verifiedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteProviderConfigurations_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_provider_config_owner_capability_unique` UNIQUE(`ownerUserId`,`capability`),
	CONSTRAINT `managed_site_provider_config_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`configurationFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteReleaseProjections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`generationCandidateId` int,
	`versionId` int NOT NULL,
	`releaseKind` enum('generated_site','existing_site') NOT NULL,
	`targetKey` varchar(120) NOT NULL,
	`canonicalDomain` varchar(253) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`status` enum('candidate','preview_pending','preview_ready','approved','checkout_pending','payment_verified','provisioning','live_verified','geo_active','retry_wait','blocked','failed','rolled_back') NOT NULL DEFAULT 'candidate',
	`previewUrl` varchar(2048),
	`providerPreviewId` varchar(160),
	`approvalFingerprint` varchar(128),
	`approvedAt` timestamp,
	`activeDeploymentReceiptFingerprint` varchar(128),
	`rollbackFromReleaseId` int,
	`blockedReasonCode` varchar(120),
	`nextSafeAction` varchar(120) NOT NULL,
	`projectionFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteReleaseProjections_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_release_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `managed_site_release_project_target_content_unique` UNIQUE(`projectId`,`targetKey`,`contentHash`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteConnectorAttempts` ADD CONSTRAINT `managedSiteConnectorAttempts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteConnectorAttempts` ADD CONSTRAINT `managedSiteConnectorAttempts_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteConnectorAttempts` ADD CONSTRAINT `fk_managed_site_connector_a_draft_order_id_a9e415145d` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteConnectorAttempts` ADD CONSTRAINT `fk_managed_site_connector_a_release_id_0fef79e84b` FOREIGN KEY (`releaseId`) REFERENCES `managedSiteReleaseProjections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteConnectorReceipts` ADD CONSTRAINT `managedSiteConnectorReceipts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteConnectorReceipts` ADD CONSTRAINT `managedSiteConnectorReceipts_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteConnectorReceipts` ADD CONSTRAINT `fk_managed_site_connector_r_draft_order_id_4d9c41abdc` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteConnectorReceipts` ADD CONSTRAINT `fk_managed_site_connector_r_release_id_5ea262c407` FOREIGN KEY (`releaseId`) REFERENCES `managedSiteReleaseProjections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteConnectorReceipts` ADD CONSTRAINT `fk_managed_site_connector_r_attempt_id_f09d20ace0` FOREIGN KEY (`attemptId`) REFERENCES `managedSiteConnectorAttempts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteGenerationCandidates` ADD CONSTRAINT `managedSiteGenerationCandidates_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteGenerationCandidates` ADD CONSTRAINT `fk_managed_site_generation__project_id_55edb3902f` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteGenerationCandidates` ADD CONSTRAINT `fk_managed_site_generation__source_version_id_60efb7f93e` FOREIGN KEY (`sourceVersionId`) REFERENCES `managedSiteVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProviderConfigurations` ADD CONSTRAINT `managedSiteProviderConfigurations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD CONSTRAINT `managedSiteReleaseProjections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD CONSTRAINT `fk_managed_site_release_pro_project_id_668c393740` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD CONSTRAINT `fk_managed_site_release_pro_generation_candida_adf21b5422` FOREIGN KEY (`generationCandidateId`) REFERENCES `managedSiteGenerationCandidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD CONSTRAINT `fk_managed_site_release_pro_version_id_8d47a77bb7` FOREIGN KEY (`versionId`) REFERENCES `managedSiteVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_connector_attempt_owner_project_status_idx` ON `managedSiteConnectorAttempts` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_connector_attempt_owner_order_idx` ON `managedSiteConnectorAttempts` (`ownerUserId`,`draftOrderId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_connector_receipt_owner_project_idx` ON `managedSiteConnectorReceipts` (`ownerUserId`,`projectId`,`verifiedAt`);--> statement-breakpoint
CREATE INDEX `managed_site_connector_receipt_owner_order_idx` ON `managedSiteConnectorReceipts` (`ownerUserId`,`draftOrderId`,`verifiedAt`);--> statement-breakpoint
CREATE INDEX `managed_site_generation_owner_project_idx` ON `managedSiteGenerationCandidates` (`ownerUserId`,`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_provider_config_owner_status_idx` ON `managedSiteProviderConfigurations` (`ownerUserId`,`readinessStatus`);--> statement-breakpoint
CREATE INDEX `managed_site_release_owner_project_status_idx` ON `managedSiteReleaseProjections` (`ownerUserId`,`projectId`,`status`);