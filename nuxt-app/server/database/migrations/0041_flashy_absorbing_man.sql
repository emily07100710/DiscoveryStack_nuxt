CREATE TABLE `managedSiteContactInboxBindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`funnelSessionId` int NOT NULL,
	`projectId` int,
	`email` varchar(320) NOT NULL,
	`status` enum('pending','bound','superseded','locked') NOT NULL DEFAULT 'pending',
	`codeHash` varchar(128),
	`codeExpiresAt` timestamp,
	`attemptCount` int NOT NULL DEFAULT 0,
	`sendCount` int NOT NULL DEFAULT 0,
	`lastSentAt` timestamp,
	`boundAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteContactInboxBindings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteModuleFulfilments` MODIFY COLUMN `moduleKey` enum('managed_content_admin','contact_lead_capture','bounded_ai_assistant','shopify_commerce','line_assisted_integration','google_booking_assisted_integration','geo_content_subscription','geo_measurement_dashboard','pwa_reference_only','stripe_payment','newebpay_payment','ecpay_payment','einvoice','logistics','erp_crm_backoffice') NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSiteContactInboxBindings` ADD CONSTRAINT `ms_contact_binding_session_fk` FOREIGN KEY (`funnelSessionId`) REFERENCES `managedSiteFunnelSessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteContactInboxBindings` ADD CONSTRAINT `ms_contact_binding_project_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ms_contact_binding_session_idx` ON `managedSiteContactInboxBindings` (`funnelSessionId`);--> statement-breakpoint
CREATE INDEX `ms_contact_binding_project_idx` ON `managedSiteContactInboxBindings` (`projectId`);