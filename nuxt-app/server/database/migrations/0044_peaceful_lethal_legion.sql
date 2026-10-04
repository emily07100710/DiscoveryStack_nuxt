CREATE TABLE `weeklyContentBindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`lineUserId` varchar(128) NOT NULL,
	`bindingFingerprint` varchar(64) NOT NULL,
	`status` enum('active','revoked') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `weeklyContentBindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `weekly_binding_owner_client_uq` UNIQUE(`ownerUserId`,`clientId`)
);
--> statement-breakpoint
CREATE TABLE `weeklyContentConfigs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`publicationTargetId` int NOT NULL,
	`policyId` varchar(160) NOT NULL,
	`policyConfigurationFingerprint` varchar(64) NOT NULL,
	`configurationFingerprint` varchar(64) NOT NULL,
	`status` enum('active','paused','revoked') NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`cadenceDays` int NOT NULL DEFAULT 7,
	`reviewTtlHours` int NOT NULL DEFAULT 72,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `weeklyContentConfigs_id` PRIMARY KEY(`id`),
	CONSTRAINT `weekly_config_owner_client_uq` UNIQUE(`ownerUserId`,`clientId`)
);
--> statement-breakpoint
CREATE TABLE `weeklyContentConsents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`requestRowId` int NOT NULL,
	`decision` enum('approved','changes_requested') NOT NULL,
	`eventHash` varchar(64) NOT NULL,
	`actorFingerprint` varchar(64) NOT NULL,
	`consentFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `weeklyContentConsents_id` PRIMARY KEY(`id`),
	CONSTRAINT `weekly_consent_event_uq` UNIQUE(`eventHash`)
);
--> statement-breakpoint
CREATE TABLE `weeklyContentInvitations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`bindingFingerprint` varchar(64),
	`eventHash` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `weeklyContentInvitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `weekly_invite_hash_uq` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `weeklyContentOutbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`requestRowId` int NOT NULL,
	`bindingId` int NOT NULL,
	`status` enum('queued','processing','retry_wait','sent','failed','cancelled') NOT NULL,
	`attemptNumber` int NOT NULL DEFAULT 0,
	`leaseToken` varchar(96),
	`leaseExpiresAt` timestamp,
	`retryEligibleAt` timestamp,
	`providerMessageId` varchar(128),
	`sentAt` timestamp,
	`errorCode` varchar(80),
	`payloadFingerprint` varchar(64),
	`firstAttemptAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `weeklyContentOutbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `weekly_outbox_request_uq` UNIQUE(`requestRowId`)
);
--> statement-breakpoint
CREATE TABLE `weeklyContentReviewRequests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`requestId` varchar(64) NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`entryId` int NOT NULL,
	`jobId` int NOT NULL,
	`contentType` varchar(40) NOT NULL,
	`language` varchar(32) NOT NULL,
	`draftId` int NOT NULL,
	`draftVersion` int NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`evidenceSnapshotHash` varchar(64) NOT NULL,
	`publicationTargetId` int NOT NULL,
	`targetConfigurationFingerprint` varchar(64) NOT NULL,
	`policyId` varchar(160) NOT NULL,
	`policyConfigurationFingerprint` varchar(64) NOT NULL,
	`configurationFingerprint` varchar(64) NOT NULL,
	`bindingId` int NOT NULL,
	`bindingFingerprint` varchar(64) NOT NULL,
	`readTokenHash` varchar(64) NOT NULL,
	`actionTokenHash` varchar(64) NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`status` enum('pending','approved','changes_requested','revoked') NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `weeklyContentReviewRequests_id` PRIMARY KEY(`id`),
	CONSTRAINT `weekly_review_opaque_uq` UNIQUE(`requestId`),
	CONSTRAINT `weekly_review_fingerprint_uq` UNIQUE(`requestFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `weeklyContentWebhookInbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventHash` varchar(64) NOT NULL,
	`payloadFingerprint` varchar(64) NOT NULL,
	`status` enum('processed') NOT NULL,
	`resultCode` varchar(80) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `weeklyContentWebhookInbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `weekly_webhook_event_uq` UNIQUE(`eventHash`)
);
--> statement-breakpoint
ALTER TABLE `contentOperationClients` MODIFY COLUMN `framework` enum('astro','nuxt','nextjs') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` MODIFY COLUMN `framework` enum('astro','nuxt','nextjs','wordpress','php_agent','generic_http','geoflow_local','static_site') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationClients` ADD `requireCustomerApproval` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `weekly_consent_request_idx` ON `weeklyContentConsents` (`requestRowId`,`id`);--> statement-breakpoint
CREATE INDEX `weekly_outbox_owner_status_idx` ON `weeklyContentOutbox` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `weekly_review_owner_status_idx` ON `weeklyContentReviewRequests` (`ownerUserId`,`status`);