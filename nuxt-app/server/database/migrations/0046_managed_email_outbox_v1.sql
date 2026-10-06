CREATE TABLE `managedSiteEmailOutbox` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int,
	`projectId` int,
	`purpose` enum('inbox_verification','customer_reaccess','member_invitation','contact_form_forward','workspace_ready') NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`authorityFingerprint` varchar(64) NOT NULL,
	`payloadFingerprint` varchar(64) NOT NULL,
	`contextFingerprint` varchar(64) NOT NULL,
	`providerConfigurationFingerprint` varchar(64) NOT NULL,
	`encryptedPayload` longtext,
	`status` enum('queued','processing','reconcile_pending','accepted','cancelled','manual_required') NOT NULL DEFAULT 'queued',
	`attemptCount` int NOT NULL DEFAULT 0,
	`firstAttemptAt` datetime(3),
	`nextAttemptAt` datetime(3) NOT NULL,
	`expiresAt` datetime(3) NOT NULL,
	`leaseToken` varchar(36),
	`leaseExpiresAt` datetime(3),
	`safeCode` varchar(80),
	`providerReceiptId` varchar(36),
	`acceptedAt` datetime(3),
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `managedSiteEmailOutbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_email_outbox_key_uq` UNIQUE(`purpose`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE INDEX `managed_email_outbox_due_idx` ON `managedSiteEmailOutbox` (`status`,`nextAttemptAt`,`id`);--> statement-breakpoint
CREATE INDEX `managed_email_outbox_owner_idx` ON `managedSiteEmailOutbox` (`ownerUserId`,`projectId`,`createdAt`);
