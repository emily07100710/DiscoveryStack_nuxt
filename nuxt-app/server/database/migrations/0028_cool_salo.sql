CREATE TABLE `managedSitePaymentWebhookInbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int,
	`projectId` int,
	`releaseId` int,
	`draftOrderId` int NOT NULL,
	`providerKey` varchar(96) NOT NULL,
	`providerEventId` varchar(160) NOT NULL,
	`eventType` varchar(96) NOT NULL,
	`canonicalPayloadHash` varchar(128) NOT NULL,
	`exactResponseIdentity` varchar(256) NOT NULL,
	`eventFingerprint` varchar(128) NOT NULL,
	`processingStatus` enum('processing','succeeded','ignored','blocked') NOT NULL DEFAULT 'processing',
	`processingFingerprint` varchar(128) NOT NULL,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `managedSitePaymentWebhookInbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_payment_inbox_provider_event_unique` UNIQUE(`providerKey`,`providerEventId`),
	CONSTRAINT `managed_site_payment_inbox_event_fingerprint_unique` UNIQUE(`eventFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteDomainClaims` DROP INDEX `managed_site_domain_claim_canonical_unique`;--> statement-breakpoint
ALTER TABLE `managedSiteDomainClaims` ADD `activeCanonicalDomainKey` varchar(253) GENERATED ALWAYS AS (CASE WHEN `status` = 'released' THEN NULL ELSE `canonicalDomain` END) STORED;--> statement-breakpoint
ALTER TABLE `managedSiteProviderConfigurations` ADD `capabilityIdentity` varchar(160);--> statement-breakpoint
ALTER TABLE `managedSiteDomainClaims` ADD CONSTRAINT `managed_site_domain_claim_active_canonical_unique` UNIQUE(`activeCanonicalDomainKey`);--> statement-breakpoint
ALTER TABLE `managedSitePaymentWebhookInbox` ADD CONSTRAINT `managedSitePaymentWebhookInbox_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentWebhookInbox` ADD CONSTRAINT `fk_managed_site_payment_web_project_id_ad7f219a2e` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentWebhookInbox` ADD CONSTRAINT `fk_managed_site_payment_web_release_id_a35c05d809` FOREIGN KEY (`releaseId`) REFERENCES `managedSiteReleaseProjections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentWebhookInbox` ADD CONSTRAINT `fk_managed_site_payment_web_draft_order_id_3e4558f042` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_payment_inbox_order_status_idx` ON `managedSitePaymentWebhookInbox` (`draftOrderId`,`processingStatus`);