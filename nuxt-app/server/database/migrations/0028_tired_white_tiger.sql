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
ALTER TABLE `managedSiteDomainClaims` ADD `activeCanonicalDomainKey` varchar(253);--> statement-breakpoint
ALTER TABLE `managedSiteDomainClaims` ADD CONSTRAINT `managed_site_domain_claim_active_canonical_unique` UNIQUE(`activeCanonicalDomainKey`);--> statement-breakpoint
ALTER TABLE `managedSitePaymentWebhookInbox` ADD CONSTRAINT `managedSitePaymentWebhookInbox_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentWebhookInbox` ADD CONSTRAINT `managedSitePaymentWebhookInbox_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentWebhookInbox` ADD CONSTRAINT `managedSitePaymentWebhookInbox_releaseId_managedSiteReleaseProjections_id_fk` FOREIGN KEY (`releaseId`) REFERENCES `managedSiteReleaseProjections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentWebhookInbox` ADD CONSTRAINT `managedSitePaymentWebhookInbox_draftOrderId_managedSiteDraftOrders_id_fk` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_payment_inbox_order_status_idx` ON `managedSitePaymentWebhookInbox` (`draftOrderId`,`processingStatus`);