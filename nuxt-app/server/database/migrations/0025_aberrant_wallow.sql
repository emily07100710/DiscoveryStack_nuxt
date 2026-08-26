/* Managed Site V1 runtime convergence repair. All legacy owner decisions are fail-closed and lineage-only. */
/*
 * PRE-FLIGHT: this block uses only columns already present in 0021-0024. It must
 * complete before any business-table ALTER/DROP or other destructive schema DDL.
 * A duplicate primary-key insert is used because MySQL/TiDB migration files do
 * not provide a portable top-level SIGNAL statement.
 */
CREATE TEMPORARY TABLE `_managed_site_0025_preflight_guard` (`marker` int NOT NULL PRIMARY KEY);
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard` VALUES (0);
--> statement-breakpoint
/* Domain owner must be resolvable from its persisted order/project lineage. */
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM `managedSiteDomainIntents` AS d
LEFT JOIN `managedSiteDraftOrders` AS o ON o.`id` = d.`draftOrderId`
LEFT JOIN `managedSiteProjects` AS p ON p.`id` = d.`projectId`
WHERE p.`id` IS NULL
   OR (d.`draftOrderId` IS NOT NULL AND o.`id` IS NULL)
   OR (d.`ownerUserId` IS NULL AND o.`ownerUserId` IS NULL AND p.`ownerUserId` IS NULL)
   OR (d.`ownerUserId` IS NOT NULL AND o.`ownerUserId` IS NOT NULL AND d.`ownerUserId` <> o.`ownerUserId`)
   OR (d.`ownerUserId` IS NOT NULL AND p.`ownerUserId` IS NOT NULL AND d.`ownerUserId` <> p.`ownerUserId`)
   OR (o.`ownerUserId` IS NOT NULL AND p.`ownerUserId` IS NOT NULL AND o.`ownerUserId` <> p.`ownerUserId`)
LIMIT 1;
--> statement-breakpoint
/* Legacy payment owner must be resolvable from one consistent order/quote/preview lineage. */
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM `managedSitePaymentEvents` AS pe
LEFT JOIN `managedSiteDraftOrders` AS o ON o.`id` = pe.`draftOrderId`
LEFT JOIN `managedSiteQuotes` AS q ON q.`id` = o.`quoteId`
LEFT JOIN `managedSitePreviews` AS p ON p.`id` = o.`previewId`
WHERE o.`id` IS NULL
   OR q.`id` IS NULL
   OR p.`id` IS NULL
   OR o.`previewId` <> p.`id`
   OR q.`previewId` <> p.`id`
   OR (o.`ownerUserId` IS NULL AND q.`ownerUserId` IS NULL AND p.`ownerUserId` IS NULL)
   OR (o.`ownerUserId` IS NOT NULL AND q.`ownerUserId` IS NOT NULL AND o.`ownerUserId` <> q.`ownerUserId`)
   OR (o.`ownerUserId` IS NOT NULL AND p.`ownerUserId` IS NOT NULL AND o.`ownerUserId` <> p.`ownerUserId`)
   OR (q.`ownerUserId` IS NOT NULL AND p.`ownerUserId` IS NOT NULL AND q.`ownerUserId` <> p.`ownerUserId`)
LIMIT 1;
--> statement-breakpoint
/* Existing global keys are checked before they can be replaced by owner-scoped keys. */
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `ownerUserId`, `intentFingerprint` FROM `managedSiteProvisioningPlans` GROUP BY `ownerUserId`, `intentFingerprint` HAVING COUNT(*) > 1
) AS provisioning_intent_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `ownerUserId`, `idempotencyKey` FROM `managedSiteProvisioningPlans` GROUP BY `ownerUserId`, `idempotencyKey` HAVING COUNT(*) > 1
) AS provisioning_idempotency_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `ownerUserId`, `intentFingerprint` FROM `managedSiteIntegrations` GROUP BY `ownerUserId`, `intentFingerprint` HAVING COUNT(*) > 1
) AS integration_intent_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `ownerUserId`, `idempotencyKey` FROM `managedSiteIntegrations` GROUP BY `ownerUserId`, `idempotencyKey` HAVING COUNT(*) > 1
) AS integration_idempotency_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `ownerUserId`, JSON_UNQUOTE(JSON_EXTRACT(`redactedConfig`, '$.shopDomain')) AS `shopDomain`
  FROM `managedSiteIntegrations`
  WHERE `moduleKey` = 'shopify_commerce'
    AND JSON_UNQUOTE(JSON_EXTRACT(`redactedConfig`, '$.shopDomain')) IS NOT NULL
    AND JSON_UNQUOTE(JSON_EXTRACT(`redactedConfig`, '$.shopDomain')) <> ''
  GROUP BY `ownerUserId`, JSON_UNQUOTE(JSON_EXTRACT(`redactedConfig`, '$.shopDomain'))
  HAVING COUNT(*) > 1
) AS integration_shop_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `ownerUserId`, `eventId` FROM (
    SELECT COALESCE(o.`ownerUserId`, q.`ownerUserId`, p.`ownerUserId`) AS `ownerUserId`, pe.`eventId`
    FROM `managedSitePaymentEvents` AS pe
    INNER JOIN `managedSiteDraftOrders` AS o ON o.`id` = pe.`draftOrderId`
    INNER JOIN `managedSiteQuotes` AS q ON q.`id` = o.`quoteId`
    INNER JOIN `managedSitePreviews` AS p ON p.`id` = o.`previewId`
  ) AS payment_events_with_owner
  GROUP BY `ownerUserId`, `eventId`
  HAVING COUNT(*) > 1
) AS payment_event_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `ownerUserId`, `eventFingerprint` FROM (
    SELECT COALESCE(o.`ownerUserId`, q.`ownerUserId`, p.`ownerUserId`) AS `ownerUserId`, pe.`eventFingerprint`
    FROM `managedSitePaymentEvents` AS pe
    INNER JOIN `managedSiteDraftOrders` AS o ON o.`id` = pe.`draftOrderId`
    INNER JOIN `managedSiteQuotes` AS q ON q.`id` = o.`quoteId`
    INNER JOIN `managedSitePreviews` AS p ON p.`id` = o.`previewId`
  ) AS payment_fingerprints_with_owner
  GROUP BY `ownerUserId`, `eventFingerprint`
  HAVING COUNT(*) > 1
) AS payment_fingerprint_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `ownerUserId`, `idempotencyKey` FROM `managedSiteDomainIntents` GROUP BY `ownerUserId`, `idempotencyKey` HAVING COUNT(*) > 1
) AS domain_idempotency_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `previewId`, `idempotencyKey` FROM `managedSiteDraftOrders` GROUP BY `previewId`, `idempotencyKey` HAVING COUNT(*) > 1
) AS draft_order_idempotency_collisions
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_preflight_guard`
SELECT 0
FROM (
  SELECT `previewId`, `idempotencyKey` FROM `managedSiteLeadIntents` GROUP BY `previewId`, `idempotencyKey` HAVING COUNT(*) > 1
) AS lead_intent_idempotency_collisions
LIMIT 1;
--> statement-breakpoint
DROP TEMPORARY TABLE `_managed_site_0025_preflight_guard`;
--> statement-breakpoint
/* The legacy fingerprint name is retained under a temporary legacy name so the final schema name can be installed before removal. */
ALTER TABLE `managedSitePaymentEvents` RENAME INDEX `managed_site_payment_events_fingerprint_unique` TO `managed_site_payment_events_legacy_fingerprint_unique`;
--> statement-breakpoint
/* Safe additive table creation follows the old-schema preflight. */
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
/* Safe additive schema: nullable lineage columns precede all tightening. */
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
/* Deterministic keys identify legacy rows only; they never grant authority. */
UPDATE `managedSiteProjects`
SET `creationIdempotencyKey` = CONCAT('legacy-project-', `id`)
WHERE `creationIdempotencyKey` IS NULL;
--> statement-breakpoint
UPDATE `managedSiteQuotes`
SET `idempotencyKey` = CONCAT('legacy-quote-', `id`)
WHERE `idempotencyKey` IS NULL;
--> statement-breakpoint
/* Domain ownership is inherited only from the same persisted order/project lineage. */
UPDATE `managedSiteDomainIntents` AS d
LEFT JOIN `managedSiteDraftOrders` AS o ON o.`id` = d.`draftOrderId`
INNER JOIN `managedSiteProjects` AS p ON p.`id` = d.`projectId`
SET d.`ownerUserId` = COALESCE(d.`ownerUserId`, o.`ownerUserId`, p.`ownerUserId`)
WHERE d.`ownerUserId` IS NULL;
--> statement-breakpoint
/* Keep the legacy Shopify domain only when its existing redacted intent contains the exact field. */
UPDATE `managedSiteIntegrations`
SET `shopDomain` = JSON_UNQUOTE(JSON_EXTRACT(`redactedConfig`, '$.shopDomain'))
WHERE `shopDomain` IS NULL
  AND `moduleKey` = 'shopify_commerce'
  AND JSON_UNQUOTE(JSON_EXTRACT(`redactedConfig`, '$.shopDomain')) IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(`redactedConfig`, '$.shopDomain')) <> '';
--> statement-breakpoint
/* Legacy payment rows are rejected and receive references only from persisted order/quote/preview lineage. */
UPDATE `managedSitePaymentEvents` AS pe
INNER JOIN `managedSiteDraftOrders` AS o ON o.`id` = pe.`draftOrderId`
INNER JOIN `managedSiteQuotes` AS q ON q.`id` = o.`quoteId`
INNER JOIN `managedSitePreviews` AS p ON p.`id` = o.`previewId`
SET pe.`ownerUserId` = COALESCE(pe.`ownerUserId`, o.`ownerUserId`, q.`ownerUserId`, p.`ownerUserId`),
    pe.`previewId` = COALESCE(pe.`previewId`, o.`previewId`),
    pe.`quoteId` = COALESCE(pe.`quoteId`, o.`quoteId`),
    pe.`providerKey` = COALESCE(pe.`providerKey`, 'legacy-blocked'),
    pe.`amountMinor` = COALESCE(pe.`amountMinor`, 0),
    pe.`currency` = COALESCE(pe.`currency`, 'UNK'),
    pe.`canonicalPayloadHash` = COALESCE(pe.`canonicalPayloadHash`, SHA2(CONCAT_WS('|', 'legacy-payment', pe.`id`, pe.`eventId`, pe.`providerReference`, pe.`eventFingerprint`), 256)),
    pe.`verificationStatus` = 'rejected';
--> statement-breakpoint
/* SECOND GUARDS: validate the completed backfill before NOT NULL, FK, or unique DDL. */
CREATE TEMPORARY TABLE `_managed_site_0025_backfill_guard` (`marker` int NOT NULL PRIMARY KEY);
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard` VALUES (0);
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0
FROM `managedSiteDomainIntents` AS d
LEFT JOIN `managedSiteDraftOrders` AS o ON o.`id` = d.`draftOrderId`
LEFT JOIN `managedSiteProjects` AS p ON p.`id` = d.`projectId`
WHERE d.`ownerUserId` IS NULL
   OR p.`id` IS NULL
   OR (d.`draftOrderId` IS NOT NULL AND o.`id` IS NULL)
   OR (o.`ownerUserId` IS NOT NULL AND d.`ownerUserId` <> o.`ownerUserId`)
   OR (p.`ownerUserId` IS NOT NULL AND d.`ownerUserId` <> p.`ownerUserId`)
   OR (o.`ownerUserId` IS NOT NULL AND p.`ownerUserId` IS NOT NULL AND o.`ownerUserId` <> p.`ownerUserId`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0
FROM `managedSitePaymentEvents` AS pe
LEFT JOIN `managedSiteDraftOrders` AS o ON o.`id` = pe.`draftOrderId`
LEFT JOIN `managedSiteQuotes` AS q ON q.`id` = pe.`quoteId`
LEFT JOIN `managedSitePreviews` AS p ON p.`id` = pe.`previewId`
LEFT JOIN `users` AS u ON u.`id` = pe.`ownerUserId`
WHERE pe.`ownerUserId` IS NULL
   OR pe.`previewId` IS NULL
   OR pe.`quoteId` IS NULL
   OR u.`id` IS NULL
   OR o.`id` IS NULL
   OR q.`id` IS NULL
   OR p.`id` IS NULL
   OR o.`previewId` <> p.`id`
   OR q.`previewId` <> p.`id`
   OR o.`quoteId` <> q.`id`
   OR o.`ownerUserId` IS NULL
   OR q.`ownerUserId` IS NULL
   OR p.`ownerUserId` IS NULL
   OR pe.`ownerUserId` <> o.`ownerUserId`
   OR pe.`ownerUserId` <> q.`ownerUserId`
   OR pe.`ownerUserId` <> p.`ownerUserId`
   OR pe.`verificationStatus` <> 'rejected'
LIMIT 1;
--> statement-breakpoint
/* Every owner-scoped replacement key is checked after deterministic backfill. */
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteProjects` GROUP BY `ownerUserId`, `creationIdempotencyKey` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteQuotes` GROUP BY `previewId`, `idempotencyKey` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteDraftOrders` GROUP BY `previewId`, `idempotencyKey` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteLeadIntents` GROUP BY `previewId`, `idempotencyKey` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSitePaymentEvents` GROUP BY `ownerUserId`, `providerKey`, `eventId` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSitePaymentEvents` GROUP BY `ownerUserId`, `eventFingerprint` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteDomainIntents` GROUP BY `ownerUserId`, `idempotencyKey` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteProvisioningPlans` GROUP BY `ownerUserId`, `intentFingerprint` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteProvisioningPlans` GROUP BY `ownerUserId`, `idempotencyKey` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteIntegrations` GROUP BY `ownerUserId`, `intentFingerprint` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteIntegrations` GROUP BY `ownerUserId`, `idempotencyKey` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
INSERT INTO `_managed_site_0025_backfill_guard`
SELECT 0 FROM `managedSiteIntegrations` WHERE `shopDomain` IS NOT NULL GROUP BY `ownerUserId`, `shopDomain` HAVING COUNT(*) > 1 LIMIT 1;
--> statement-breakpoint
DROP TEMPORARY TABLE `_managed_site_0025_backfill_guard`;
--> statement-breakpoint
/* Tighten nullable fields only after both guard phases have completed. */
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
ALTER TABLE `managedSiteDomainIntents` MODIFY COLUMN `ownerUserId` int NOT NULL;
--> statement-breakpoint
/* New owner/lineage-scoped keys are created before legacy global keys are removed. */
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
/* New foreign keys are added only after owner/lineage backfill and constraints are safe. */
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
/* Only now can obsolete global keys be removed; replacements already exist. */
ALTER TABLE `managedSiteDraftOrders` DROP INDEX `managed_site_draft_orders_idempotency_unique`;
--> statement-breakpoint
ALTER TABLE `managedSiteLeadIntents` DROP INDEX `managed_site_lead_intents_idempotency_unique`;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` DROP INDEX `managed_site_payment_events_event_unique`;
--> statement-breakpoint
ALTER TABLE `managedSitePaymentEvents` DROP INDEX `managed_site_payment_events_legacy_fingerprint_unique`;
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
/* New table indexes and indexes already created by 0021-0024 remain in place. */
CREATE INDEX `managed_site_shopify_authorizations_owner_project_status_idx` ON `managedSiteShopifyAuthorizations` (`ownerUserId`,`projectId`,`status`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `managed_site_shopify_webhooks_owner_project_idx` ON `managedSiteShopifyWebhooks` (`ownerUserId`,`projectId`,`receivedAt`);
