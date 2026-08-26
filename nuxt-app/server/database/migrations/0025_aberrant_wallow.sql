/* Managed Site V1 runtime convergence repair. This migration is intentionally fail-closed for unresolved legacy lineage. */
CREATE TABLE `managedSiteShopifyAuthorizations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`integrationId` int NOT NULL,
	`stateHash` varchar(128) NOT NULL,
	`nonceHash` varchar(128),
	`codeVerifierHash` varchar(128),
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
/* Existing global keys are removed before their owner/lineage-scoped replacements are created. */
ALTER TABLE `managedSiteDraftOrders` DROP INDEX `managed_site_draft_orders_idempotency_unique`;
--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` DROP INDEX `managed_site_lead_intents_idempotency_unique`;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` DROP INDEX `managed_site_payment_events_event_unique`;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` DROP INDEX `managed_site_payment_events_fingerprint_unique`;
--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` DROP INDEX `managed_site_provisioning_plans_intent_unique`;
--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` DROP INDEX `managed_site_provisioning_plans_idempotency_unique`;
--> statement-breakpoint
ALTER TABLE `managedSiteDomainIntents` DROP INDEX `managed_site_domain_intents_idempotency_unique`;
--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` DROP INDEX `managed_site_integrations_intent_unique`;
--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` DROP INDEX `managed_site_integrations_idempotency_unique`;
--> statement-breakpoint
/* New columns start nullable so legacy rows can be reconciled before constraints are tightened. */
ALTER TABLE `managedSiteProjects` ADD `creationIdempotencyKey` varchar(128);
--> statement-breakpoint
ALTER TABLE `managedSiteQuotes` ADD `idempotencyKey` varchar(128);
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `ownerUserId` int;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `previewId` int;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `quoteId` int;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `providerKey` varchar(96);
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `amountMinor` int;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `currency` varchar(3);
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD `canonicalPayloadHash` varchar(128);
--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` ADD `shopDomain` varchar(253);
--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` MODIFY COLUMN `status` enum('draft','awaiting_payment','awaiting_authorization','queued','processing','retry_wait','blocked','failed','succeeded','cancelled') NOT NULL DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD `leaseOwner` varchar(128);
--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD `leaseExpiresAt` timestamp;
--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD `retryEligibleAt` timestamp;
--> statement-breakpoint
/* Deterministic keys are lineage markers only; they do not grant authority or create a user. */
UPDATE `managedSiteProjects` SET `creationIdempotencyKey` = CONCAT('legacy-project-', `id`) WHERE `creationIdempotencyKey` IS NULL;
--> statement-breakpoint
UPDATE `managedSiteQuotes` SET `idempotencyKey` = CONCAT('legacy-quote-', `id`) WHERE `idempotencyKey` IS NULL;
--> statement-breakpoint
/* A domain intent inherits ownership from its draft order when available, otherwise its project. */
UPDATE `managedSiteDomainIntents` AS d
LEFT JOIN `managedSiteDraftOrders` AS o ON o.`id` = d.`draftOrderId`
INNER JOIN `managedSiteProjects` AS p ON p.`id` = d.`projectId`
SET d.`ownerUserId` = COALESCE(d.`ownerUserId`, o.`ownerUserId`, p.`ownerUserId`)
WHERE d.`ownerUserId` IS NULL;
--> statement-breakpoint
/* A duplicate-key guard aborts this migration if any domain row still lacks a deterministic owner. */
CREATE TEMPORARY TABLE `_managed_site_0025_domain_owner_guard` (`marker` int NOT NULL PRIMARY KEY);
--> statement-breakpoint
INSERT INTO `_managed_site_0025_domain_owner_guard` VALUES (-1);
--> statement-breakpoint
INSERT INTO `_managed_site_0025_domain_owner_guard` SELECT -1 FROM `managedSiteDomainIntents` WHERE `ownerUserId` IS NULL LIMIT 1;
--> statement-breakpoint
DROP TEMPORARY TABLE `_managed_site_0025_domain_owner_guard`;
--> statement-breakpoint
ALTER TABLE `managedSiteDomainIntents` MODIFY COLUMN `ownerUserId` int NOT NULL;
--> statement-breakpoint
/* Legacy payment rows are reduced to safe lineage references and explicitly rejected, never upgraded to verified. */
UPDATE `managedSitePaymentEvents` AS pe
LEFT JOIN `managedSiteDraftOrders` AS o ON o.`id` = pe.`draftOrderId`
LEFT JOIN `managedSitePreviews` AS p ON p.`id` = o.`previewId`
LEFT JOIN `managedSiteQuotes` AS q ON q.`id` = o.`quoteId`
LEFT JOIN `leads` AS l ON l.`id` = o.`leadId`
LEFT JOIN `users` AS u ON LOWER(u.`email`) = LOWER(l.`email`)
SET pe.`ownerUserId` = COALESCE(pe.`ownerUserId`, o.`ownerUserId`, q.`ownerUserId`, p.`ownerUserId`, u.`id`),
    pe.`previewId` = COALESCE(pe.`previewId`, o.`previewId`),
    pe.`quoteId` = COALESCE(pe.`quoteId`, o.`quoteId`),
    pe.`providerKey` = COALESCE(pe.`providerKey`, 'legacy-blocked'),
    pe.`amountMinor` = COALESCE(pe.`amountMinor`, 0),
    pe.`currency` = COALESCE(pe.`currency`, 'UNK'),
    pe.`canonicalPayloadHash` = COALESCE(pe.`canonicalPayloadHash`, SHA2(CONCAT_WS('|', 'legacy-payment', pe.`id`, pe.`eventId`, pe.`providerReference`, pe.`eventFingerprint`), 256)),
    pe.`verificationStatus` = 'rejected';
--> statement-breakpoint
/* Unresolved payment owner/order lineage aborts before NOT NULL/FK conversion; no production authority is fabricated. */
CREATE TEMPORARY TABLE `_managed_site_0025_payment_owner_guard` (`marker` int NOT NULL PRIMARY KEY);
--> statement-breakpoint
INSERT INTO `_managed_site_0025_payment_owner_guard` VALUES (-1);
--> statement-breakpoint
INSERT INTO `_managed_site_0025_payment_owner_guard` SELECT -1 FROM `managedSitePaymentEvents` WHERE `ownerUserId` IS NULL OR `previewId` IS NULL OR `quoteId` IS NULL LIMIT 1;
--> statement-breakpoint
DROP TEMPORARY TABLE `_managed_site_0025_payment_owner_guard`;
--> statement-breakpoint
ALTER TABLE `managedSiteProjects` MODIFY COLUMN `creationIdempotencyKey` varchar(128) NOT NULL;
--> statement-breakpoint
ALTER TABLE `managedSiteQuotes` MODIFY COLUMN `idempotencyKey` varchar(128) NOT NULL;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `ownerUserId` int NOT NULL;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `previewId` int NOT NULL;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `quoteId` int NOT NULL;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `providerKey` varchar(96) NOT NULL;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `amountMinor` int NOT NULL;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `currency` varchar(3) NOT NULL;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` MODIFY COLUMN `canonicalPayloadHash` varchar(128) NOT NULL;
--> statement-breakpoint
/* Final owner/lineage-scoped unique indexes are added only after backfill and null guards. */
ALTER TABLE `managedSiteDraftOrders` ADD CONSTRAINT `managed_site_draft_orders_preview_idempotency_unique` UNIQUE(`previewId`,`idempotencyKey`);
--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` ADD CONSTRAINT `managed_site_lead_intents_preview_idempotency_unique` UNIQUE(`previewId`,`idempotencyKey`);
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managed_site_payment_events_owner_provider_event_unique` UNIQUE(`ownerUserId`,`providerKey`,`eventId`);
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managed_site_payment_events_fingerprint_unique` UNIQUE(`ownerUserId`,`eventFingerprint`);
--> statement-breakpoint
ALTER TABLE `managedSiteProjects` ADD CONSTRAINT `managed_site_projects_owner_creation_idempotency_unique` UNIQUE(`ownerUserId`,`creationIdempotencyKey`);
--> statement-breakpoint
ALTER TABLE `managedSiteQuotes` ADD CONSTRAINT `managed_site_quotes_preview_idempotency_unique` UNIQUE(`previewId`,`idempotencyKey`);
--> statement-breakpoint
ALTER TABLE `managedSiteDomainIntents` ADD CONSTRAINT `managed_site_domain_intents_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`);
--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD CONSTRAINT `managed_site_provisioning_plans_owner_intent_unique` UNIQUE(`ownerUserId`,`intentFingerprint`);
--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD CONSTRAINT `managed_site_provisioning_plans_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`);
--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` ADD CONSTRAINT `managed_site_integrations_owner_intent_unique` UNIQUE(`ownerUserId`,`intentFingerprint`);
--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` ADD CONSTRAINT `managed_site_integrations_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`);
--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` ADD CONSTRAINT `managed_site_integrations_owner_shop_domain_unique` UNIQUE(`ownerUserId`,`shopDomain`);
--> statement-breakpoint
/* New foreign keys are added last, after deterministic backfill has established valid references. */
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managedSitePaymentEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managedSitePaymentEvents_previewId_managedSitePreviews_id_fk` FOREIGN KEY (`previewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` ADD CONSTRAINT `managedSitePaymentEvents_quoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `managedSiteShopifyAuthorizations` ADD CONSTRAINT `managedSiteShopifyAuthorizations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `managedSiteShopifyAuthorizations` ADD CONSTRAINT `managedSiteShopifyAuthorizations_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `managedSiteShopifyAuthorizations` ADD CONSTRAINT `managedSiteShopifyAuthorizations_integrationId_managedSiteIntegrations_id_fk` FOREIGN KEY (`integrationId`) REFERENCES `managedSiteIntegrations`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `managedSiteShopifyWebhooks` ADD CONSTRAINT `managedSiteShopifyWebhooks_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `managedSiteShopifyWebhooks` ADD CONSTRAINT `managedSiteShopifyWebhooks_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `managedSiteShopifyWebhooks` ADD CONSTRAINT `managedSiteShopifyWebhooks_integrationId_managedSiteIntegrations_id_fk` FOREIGN KEY (`integrationId`) REFERENCES `managedSiteIntegrations`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `managed_site_shopify_authorizations_owner_project_status_idx` ON `managedSiteShopifyAuthorizations` (`ownerUserId`,`projectId`,`status`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `managed_site_shopify_webhooks_owner_project_idx` ON `managedSiteShopifyWebhooks` (`ownerUserId`,`projectId`,`receivedAt`);
--> statement-breakpoint
CREATE INDEX `managed_site_quotes_preview_status_idx` ON `managedSiteQuotes` (`previewId`,`status`);
--> statement-breakpoint
CREATE INDEX `managed_site_lead_intents_preview_idx` ON `managedSiteLeadIntents` (`previewId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `managed_site_payment_events_order_idx` ON `managedSitePaymentEvents` (`draftOrderId`,`receivedAt`);
