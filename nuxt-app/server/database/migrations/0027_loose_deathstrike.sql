CREATE TABLE `managedSiteDomainClaims` (
	`id` int AUTO_INCREMENT NOT NULL,
	`canonicalDomain` varchar(253) NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`releaseId` int NOT NULL,
	`claimKind` enum('generated','existing') NOT NULL,
	`status` enum('pending','verified','released','blocked') NOT NULL DEFAULT 'pending',
	`authorityReceiptFingerprint` varchar(128),
	`requestFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`projectionFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteDomainClaims_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_domain_claim_canonical_unique` UNIQUE(`canonicalDomain`),
	CONSTRAINT `managed_site_domain_claim_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `managed_site_domain_claim_release_unique` UNIQUE(`releaseId`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteGateResults` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`versionId` int NOT NULL,
	`generationCandidateId` int NOT NULL,
	`releaseId` int NOT NULL,
	`gateType` enum('artifact_admission','deterministic_compiler','preview_build','security_static_active_content','geo_content_structure','human_review') NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`result` enum('passed','failed','required') NOT NULL,
	`reasonCodes` json NOT NULL,
	`limitations` json NOT NULL,
	`receiptFingerprint` varchar(128) NOT NULL,
	`observedAt` timestamp NOT NULL,
	CONSTRAINT `managedSiteGateResults_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_gate_release_type_input_unique` UNIQUE(`releaseId`,`gateType`,`inputFingerprint`),
	CONSTRAINT `managed_site_gate_owner_receipt_unique` UNIQUE(`ownerUserId`,`receiptFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSitePrePurchaseBindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`sourceVersionId` int NOT NULL,
	`previewId` int NOT NULL,
	`quoteId` int NOT NULL,
	`draftOrderId` int NOT NULL,
	`commerceSnapshotFingerprint` varchar(128) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSitePrePurchaseBindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_prepurchase_project_unique` UNIQUE(`projectId`),
	CONSTRAINT `managed_site_prepurchase_order_unique` UNIQUE(`draftOrderId`),
	CONSTRAINT `managed_site_prepurchase_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `managed_site_prepurchase_owner_request_unique` UNIQUE(`ownerUserId`,`requestFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` MODIFY COLUMN `status` enum('candidate','preview_pending','preview_ready','approved','checkout_pending','payment_verified','provisioning','deployment_pending','rollback_pending','live_verified','geo_active','retry_wait','blocked','failed','rolled_back') NOT NULL DEFAULT 'candidate';--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD `previewId` int;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD `quoteId` int;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD `draftOrderId` int;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD `commerceSnapshotFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `managedSiteDomainClaims` ADD CONSTRAINT `managedSiteDomainClaims_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteDomainClaims` ADD CONSTRAINT `managedSiteDomainClaims_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteDomainClaims` ADD CONSTRAINT `managedSiteDomainClaims_releaseId_managedSiteReleaseProjections_id_fk` FOREIGN KEY (`releaseId`) REFERENCES `managedSiteReleaseProjections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteGateResults` ADD CONSTRAINT `managedSiteGateResults_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteGateResults` ADD CONSTRAINT `managedSiteGateResults_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteGateResults` ADD CONSTRAINT `managedSiteGateResults_versionId_managedSiteVersions_id_fk` FOREIGN KEY (`versionId`) REFERENCES `managedSiteVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteGateResults` ADD CONSTRAINT `managedSiteGateResults_generationCandidateId_managedSiteGenerationCandidates_id_fk` FOREIGN KEY (`generationCandidateId`) REFERENCES `managedSiteGenerationCandidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteGateResults` ADD CONSTRAINT `managedSiteGateResults_releaseId_managedSiteReleaseProjections_id_fk` FOREIGN KEY (`releaseId`) REFERENCES `managedSiteReleaseProjections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePrePurchaseBindings` ADD CONSTRAINT `managedSitePrePurchaseBindings_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePrePurchaseBindings` ADD CONSTRAINT `managedSitePrePurchaseBindings_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePrePurchaseBindings` ADD CONSTRAINT `managedSitePrePurchaseBindings_sourceVersionId_managedSiteVersions_id_fk` FOREIGN KEY (`sourceVersionId`) REFERENCES `managedSiteVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePrePurchaseBindings` ADD CONSTRAINT `managedSitePrePurchaseBindings_previewId_managedSitePreviews_id_fk` FOREIGN KEY (`previewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePrePurchaseBindings` ADD CONSTRAINT `managedSitePrePurchaseBindings_quoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePrePurchaseBindings` ADD CONSTRAINT `managedSitePrePurchaseBindings_draftOrderId_managedSiteDraftOrders_id_fk` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_domain_claim_owner_project_status_idx` ON `managedSiteDomainClaims` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_gate_owner_release_result_idx` ON `managedSiteGateResults` (`ownerUserId`,`releaseId`,`result`);--> statement-breakpoint
CREATE INDEX `managed_site_prepurchase_owner_lineage_idx` ON `managedSitePrePurchaseBindings` (`ownerUserId`,`previewId`,`quoteId`,`draftOrderId`);--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD CONSTRAINT `managedSiteReleaseProjections_previewId_managedSitePreviews_id_fk` FOREIGN KEY (`previewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD CONSTRAINT `managedSiteReleaseProjections_quoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteReleaseProjections` ADD CONSTRAINT `managedSiteReleaseProjections_draftOrderId_managedSiteDraftOrders_id_fk` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_release_commerce_lineage_idx` ON `managedSiteReleaseProjections` (`ownerUserId`,`previewId`,`quoteId`,`draftOrderId`);