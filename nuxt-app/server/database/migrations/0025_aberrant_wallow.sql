CREATE TABLE `managedSiteShopifyAuthorizations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`integrationId` int NOT NULL,
	`stateHash` varchar(128) NOT NULL,
	`nonceHash` varchar(128) NOT NULL,
	`codeVerifierHash` varchar(128) NOT NULL,
	`shopDomain` varchar(253) NOT NULL,
	`redirectUri` varchar(2048) NOT NULL,
	`status` enum('pending','consumed','expired','revoked') NOT NULL DEFAULT 'pending',
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteShopifyAuthorizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_shopify_authorizations_state_unique` UNIQUE(`stateHash`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteShopifyWebhooks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`integrationId` int NOT NULL,
	`shopDomain` varchar(253) NOT NULL,
	`webhookId` varchar(160) NOT NULL,
	`topic` varchar(160) NOT NULL,
	`payloadHash` varchar(128) NOT NULL,
	`signatureHash` varchar(128) NOT NULL,
	`status` enum('accepted','replayed','rejected') NOT NULL,
	`eventFingerprint` varchar(128) NOT NULL,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteShopifyWebhooks_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_shopify_webhooks_integration_event_unique` UNIQUE(`integrationId`,`webhookId`),
	CONSTRAINT `managed_site_shopify_webhooks_fingerprint_unique` UNIQUE(`ownerUserId`,`eventFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteDraftOrders` DROP INDEX `managed_site_draft_orders_idempotency_unique`;--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` DROP INDEX `managed_site_lead_intents_idempotency_unique`;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` DROP INDEX `managed_site_payment_events_event_unique`;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` DROP INDEX `managed_site_payment_events_fingerprint_unique`;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` MODIFY COLUMN `status` enum('draft','awaiting_payment','awaiting_authorization','queued','processing','retry_wait','blocked','failed','succeeded','cancelled') NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` ADD `shopDomain` varchar(253);--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `ownerUserId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `previewId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `quoteId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `providerKey` varchar(96) NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `amountMinor` int NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `currency` varchar(3) NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `canonicalPayloadHash` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSiteProjects` ADD `creationIdempotencyKey` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD `leaseOwner` varchar(128);--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD `leaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD `retryEligibleAt` timestamp;--> statement-breakpoint
ALTER TABLE `managedSiteQuotes` ADD `idempotencyKey` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSiteDraftOrders` ADD CONSTRAINT `managed_site_draft_orders_preview_idempotency_unique` UNIQUE(`previewId`,`idempotencyKey`);--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` ADD CONSTRAINT `managed_site_integrations_shop_domain_unique` UNIQUE(`shopDomain`);--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` ADD CONSTRAINT `managed_site_lead_intents_preview_idempotency_unique` UNIQUE(`previewId`,`idempotencyKey`);--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managed_site_payment_events_owner_provider_event_unique` UNIQUE(`ownerUserId`,`providerKey`,`eventId`);--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managed_site_payment_events_fingerprint_unique` UNIQUE(`ownerUserId`,`eventFingerprint`);--> statement-breakpoint
ALTER TABLE `managedSiteProjects` ADD CONSTRAINT `managed_site_projects_owner_creation_idempotency_unique` UNIQUE(`ownerUserId`,`creationIdempotencyKey`);--> statement-breakpoint
ALTER TABLE `managedSiteQuotes` ADD CONSTRAINT `managed_site_quotes_preview_idempotency_unique` UNIQUE(`previewId`,`idempotencyKey`);--> statement-breakpoint
ALTER TABLE `managedSiteShopifyAuthorizations` ADD CONSTRAINT `managedSiteShopifyAuthorizations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteShopifyAuthorizations` ADD CONSTRAINT `managedSiteShopifyAuthorizations_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteShopifyAuthorizations` ADD CONSTRAINT `managedSiteShopifyAuthorizations_integrationId_managedSiteIntegrations_id_fk` FOREIGN KEY (`integrationId`) REFERENCES `managedSiteIntegrations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteShopifyWebhooks` ADD CONSTRAINT `managedSiteShopifyWebhooks_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteShopifyWebhooks` ADD CONSTRAINT `managedSiteShopifyWebhooks_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteShopifyWebhooks` ADD CONSTRAINT `managedSiteShopifyWebhooks_integrationId_managedSiteIntegrations_id_fk` FOREIGN KEY (`integrationId`) REFERENCES `managedSiteIntegrations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_shopify_authorizations_owner_project_status_idx` ON `managedSiteShopifyAuthorizations` (`ownerUserId`,`projectId`,`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `managed_site_shopify_webhooks_owner_project_idx` ON `managedSiteShopifyWebhooks` (`ownerUserId`,`projectId`,`receivedAt`);--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managedSitePaymentEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managedSitePaymentEvents_previewId_managedSitePreviews_id_fk` FOREIGN KEY (`previewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managedSitePaymentEvents_quoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;