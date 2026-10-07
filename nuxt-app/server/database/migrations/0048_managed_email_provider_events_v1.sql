CREATE TABLE `managedSiteEmailProviderEvents` (
	`id` varchar(64) NOT NULL,
	`providerReceiptId` varchar(36) NOT NULL,
	`eventType` enum('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed') NOT NULL,
	`payloadFingerprint` varchar(64) NOT NULL,
	`providerConfigurationFingerprint` varchar(64) NOT NULL,
	`verificationFingerprint` varchar(64) NOT NULL,
	`occurredAt` datetime(3) NOT NULL,
	`receivedAt` datetime(3) NOT NULL,
	CONSTRAINT `managedSiteEmailProviderEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `managed_email_event_receipt_idx` ON `managedSiteEmailProviderEvents` (`providerConfigurationFingerprint`,`providerReceiptId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `managed_email_event_received_idx` ON `managedSiteEmailProviderEvents` (`receivedAt`,`id`);--> statement-breakpoint
CREATE INDEX `managed_email_outbox_receipt_idx` ON `managedSiteEmailOutbox` (`providerConfigurationFingerprint`,`providerReceiptId`);