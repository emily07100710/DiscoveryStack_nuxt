CREATE TABLE `managedSiteDraftOrders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int,
	`previewId` int NOT NULL,
	`quoteId` int NOT NULL,
	`projectId` int,
	`leadId` int NOT NULL,
	`status` enum('draft','payment_pending','payment_verified','cancelled','expired') NOT NULL DEFAULT 'draft',
	`requestFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`paymentIntentReference` varchar(160),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteDraftOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_draft_orders_idempotency_unique` UNIQUE(`idempotencyKey`),
	CONSTRAINT `managed_site_draft_orders_request_unique` UNIQUE(`requestFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteLeadIntents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int,
	`previewId` int NOT NULL,
	`quoteId` int,
	`leadId` int NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteLeadIntents_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_lead_intents_idempotency_unique` UNIQUE(`idempotencyKey`),
	CONSTRAINT `managed_site_lead_intents_request_unique` UNIQUE(`requestFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSitePaymentEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`draftOrderId` int NOT NULL,
	`eventId` varchar(160) NOT NULL,
	`providerReference` varchar(160) NOT NULL,
	`eventType` varchar(96) NOT NULL,
	`verificationStatus` enum('verified','rejected','replayed') NOT NULL,
	`eventFingerprint` varchar(128) NOT NULL,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSitePaymentEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_payment_events_event_unique` UNIQUE(`eventId`),
	CONSTRAINT `managed_site_payment_events_fingerprint_unique` UNIQUE(`eventFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSitePreviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int,
	`draftKey` varchar(160) NOT NULL,
	`accessTokenHash` varchar(128) NOT NULL,
	`sourceMode` enum('new_site','existing_site') NOT NULL,
	`existingSiteUrl` varchar(2048),
	`brief` text NOT NULL,
	`businessGoals` json NOT NULL,
	`styleProfile` json NOT NULL,
	`siteSpecSnapshot` json NOT NULL,
	`designTokenSnapshot` json NOT NULL,
	`selectedModuleSnapshot` json NOT NULL,
	`previewFingerprint` varchar(128) NOT NULL,
	`status` enum('draft','generated','saved','expired','converted') NOT NULL DEFAULT 'generated',
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSitePreviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_previews_draft_key_unique` UNIQUE(`draftKey`),
	CONSTRAINT `managed_site_previews_access_token_unique` UNIQUE(`accessTokenHash`),
	CONSTRAINT `managed_site_previews_fingerprint_unique` UNIQUE(`previewFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteQuoteLines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`quoteId` int NOT NULL,
	`lineKey` varchar(96) NOT NULL,
	`description` varchar(300) NOT NULL,
	`quantity` int NOT NULL,
	`unitAmountMinor` int NOT NULL,
	`lineAmountMinor` int NOT NULL,
	`catalogVersion` varchar(96) NOT NULL,
	`lineFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteQuoteLines_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_quote_lines_quote_key_unique` UNIQUE(`quoteId`,`lineKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteQuotes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int,
	`previewId` int NOT NULL,
	`projectId` int,
	`quoteVersion` varchar(96) NOT NULL,
	`planKey` varchar(96) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`totalMinor` int NOT NULL,
	`taxStatus` enum('not_calculated','limited') NOT NULL,
	`moduleSnapshot` json NOT NULL,
	`cadenceDays` int NOT NULL,
	`domainOption` enum('existing','new','assisted') NOT NULL,
	`siteSpecFingerprint` varchar(128) NOT NULL,
	`quoteFingerprint` varchar(128) NOT NULL,
	`status` enum('draft','quoted','expired','locked','cancelled') NOT NULL DEFAULT 'quoted',
	`expiresAt` timestamp NOT NULL,
	`lockedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteQuotes_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_quotes_fingerprint_unique` UNIQUE(`quoteFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteSubscriptionIntents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int,
	`projectId` int,
	`quoteId` int NOT NULL,
	`planKey` varchar(96) NOT NULL,
	`cadenceDays` int NOT NULL,
	`termMonths` int NOT NULL,
	`status` enum('draft','entitled','blocked') NOT NULL DEFAULT 'draft',
	`intentFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteSubscriptionIntents_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_subscription_intents_quote_unique` UNIQUE(`quoteId`),
	CONSTRAINT `managed_site_subscription_intents_fingerprint_unique` UNIQUE(`intentFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteDraftOrders` ADD CONSTRAINT `managedSiteDraftOrders_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteDraftOrders` ADD CONSTRAINT `managedSiteDraftOrders_previewId_managedSitePreviews_id_fk` FOREIGN KEY (`previewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteDraftOrders` ADD CONSTRAINT `managedSiteDraftOrders_quoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteDraftOrders` ADD CONSTRAINT `managedSiteDraftOrders_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteDraftOrders` ADD CONSTRAINT `managedSiteDraftOrders_leadId_leads_id_fk` FOREIGN KEY (`leadId`) REFERENCES `leads`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` ADD CONSTRAINT `managedSiteLeadIntents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` ADD CONSTRAINT `managedSiteLeadIntents_previewId_managedSitePreviews_id_fk` FOREIGN KEY (`previewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` ADD CONSTRAINT `managedSiteLeadIntents_quoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` ADD CONSTRAINT `managedSiteLeadIntents_leadId_leads_id_fk` FOREIGN KEY (`leadId`) REFERENCES `leads`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `fk_managed_site_payment_eve_draft_order_id_3b2b4659e3` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePreviews` ADD CONSTRAINT `managedSitePreviews_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteQuoteLines` ADD CONSTRAINT `managedSiteQuoteLines_quoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteQuotes` ADD CONSTRAINT `managedSiteQuotes_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteQuotes` ADD CONSTRAINT `managedSiteQuotes_previewId_managedSitePreviews_id_fk` FOREIGN KEY (`previewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteQuotes` ADD CONSTRAINT `managedSiteQuotes_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteSubscriptionIntents` ADD CONSTRAINT `managedSiteSubscriptionIntents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteSubscriptionIntents` ADD CONSTRAINT `fk_managed_site_subscriptio_project_id_7b2e347c92` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteSubscriptionIntents` ADD CONSTRAINT `managedSiteSubscriptionIntents_quoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_draft_orders_owner_status_idx` ON `managedSiteDraftOrders` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_lead_intents_preview_idx` ON `managedSiteLeadIntents` (`previewId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_payment_events_order_idx` ON `managedSitePaymentEvents` (`draftOrderId`,`receivedAt`);--> statement-breakpoint
CREATE INDEX `managed_site_previews_owner_status_idx` ON `managedSitePreviews` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_quote_lines_quote_idx` ON `managedSiteQuoteLines` (`quoteId`);--> statement-breakpoint
CREATE INDEX `managed_site_quotes_preview_status_idx` ON `managedSiteQuotes` (`previewId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_quotes_owner_status_idx` ON `managedSiteQuotes` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_subscription_intents_owner_status_idx` ON `managedSiteSubscriptionIntents` (`ownerUserId`,`status`);