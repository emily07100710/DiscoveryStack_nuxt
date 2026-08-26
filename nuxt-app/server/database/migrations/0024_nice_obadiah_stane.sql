CREATE TABLE `managedSiteIntegrations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`moduleKey` enum('bounded_ai_assistant','shopify_commerce','line_assisted_integration','google_booking_assisted_integration','payment','invoice','membership','pwa_reference_only') NOT NULL,
	`providerKey` varchar(96) NOT NULL,
	`status` enum('not_configured','awaiting_authorization','mock_verified','active','blocked','revoked') NOT NULL DEFAULT 'not_configured',
	`authorizationMode` enum('none','customer_oauth','customer_api_key','owner_configured','manual_assistance') NOT NULL,
	`requiredScopes` json NOT NULL,
	`redactedConfig` json NOT NULL,
	`intentFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`externalReference` varchar(160),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteIntegrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_integrations_project_module_unique` UNIQUE(`projectId`,`moduleKey`),
	CONSTRAINT `managed_site_integrations_intent_unique` UNIQUE(`intentFingerprint`),
	CONSTRAINT `managed_site_integrations_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` ADD CONSTRAINT `managedSiteIntegrations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteIntegrations` ADD CONSTRAINT `managedSiteIntegrations_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_integrations_owner_status_idx` ON `managedSiteIntegrations` (`ownerUserId`,`status`,`createdAt`);