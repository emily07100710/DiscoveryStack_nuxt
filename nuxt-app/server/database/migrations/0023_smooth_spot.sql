CREATE TABLE `managedSiteDomainIntents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int,
	`projectId` int NOT NULL,
	`draftOrderId` int,
	`mode` enum('customer_owned','new_registration','assisted') NOT NULL,
	`requestedDomain` varchar(253) NOT NULL,
	`normalizedDomain` varchar(253) NOT NULL,
	`ownershipStatus` enum('unknown','customer_confirmed','provider_verified','needs_customer_action') NOT NULL DEFAULT 'unknown',
	`purchaseStatus` enum('not_requested','intent_created','pending_provider','registered','failed','cancelled') NOT NULL DEFAULT 'not_requested',
	`dnsStatus` enum('not_requested','pending_customer','pending_provider','verified','failed') NOT NULL DEFAULT 'not_requested',
	`providerKey` varchar(96),
	`providerReference` varchar(160),
	`configurationFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteDomainIntents_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_domain_intents_project_unique` UNIQUE(`projectId`),
	CONSTRAINT `managed_site_domain_intents_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteProvisioningEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`planId` int NOT NULL,
	`stepId` int,
	`eventType` varchar(120) NOT NULL,
	`executionMode` enum('dry_run','mocked','external') NOT NULL,
	`status` enum('planned','blocked','succeeded','failed') NOT NULL,
	`providerKey` varchar(96),
	`externalReference` varchar(160),
	`receiptFingerprint` varchar(128) NOT NULL,
	`metadata` json NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteProvisioningEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_provisioning_events_receipt_unique` UNIQUE(`ownerUserId`,`receiptFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteProvisioningPlans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`versionId` int NOT NULL,
	`domainIntentId` int NOT NULL,
	`platform` enum('vercel','cloudflare_pages','manual_export') NOT NULL,
	`deploymentMode` enum('preview_only','customer_authorized','owner_authorized') NOT NULL DEFAULT 'preview_only',
	`status` enum('draft','awaiting_payment','awaiting_authorization','queued','processing','blocked','failed','succeeded','cancelled') NOT NULL DEFAULT 'draft',
	`domainStatus` enum('not_started','awaiting_customer','provider_pending','verified','blocked') NOT NULL DEFAULT 'not_started',
	`dnsStatus` enum('not_started','awaiting_customer','provider_pending','verified','blocked') NOT NULL DEFAULT 'not_started',
	`tlsStatus` enum('not_started','provider_pending','verified','blocked') NOT NULL DEFAULT 'not_started',
	`deploymentStatus` enum('not_started','provider_pending','built','released','blocked','failed') NOT NULL DEFAULT 'not_started',
	`intentFingerprint` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`providerProjectReference` varchar(160),
	`providerDeploymentReference` varchar(160),
	`deployedUrl` varchar(2048),
	`tlsCertificateReference` varchar(160),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteProvisioningPlans_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_provisioning_plans_project_version_unique` UNIQUE(`projectId`,`versionId`),
	CONSTRAINT `managed_site_provisioning_plans_intent_unique` UNIQUE(`intentFingerprint`),
	CONSTRAINT `managed_site_provisioning_plans_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteProvisioningSteps` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`planId` int NOT NULL,
	`stepKey` varchar(96) NOT NULL,
	`ordinal` int NOT NULL,
	`status` enum('pending','awaiting_customer','blocked','processing','retry_wait','succeeded','failed','cancelled') NOT NULL DEFAULT 'pending',
	`providerKey` varchar(96),
	`attemptNumber` int NOT NULL DEFAULT 0,
	`inputFingerprint` varchar(128) NOT NULL,
	`outputFingerprint` varchar(128),
	`errorCode` varchar(120),
	`errorSummary` varchar(500),
	`externalReference` varchar(160),
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteProvisioningSteps_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_provisioning_steps_plan_key_unique` UNIQUE(`planId`,`stepKey`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteDomainIntents` ADD CONSTRAINT `managedSiteDomainIntents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteDomainIntents` ADD CONSTRAINT `managedSiteDomainIntents_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteDomainIntents` ADD CONSTRAINT `fk_managed_site_domain_inte_draft_order_id_a0bedc94c0` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningEvents` ADD CONSTRAINT `managedSiteProvisioningEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningEvents` ADD CONSTRAINT `fk_managed_site_provisionin_project_id_7972f5fd7e` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningEvents` ADD CONSTRAINT `fk_managed_site_provisionin_plan_id_6c4258c2d1` FOREIGN KEY (`planId`) REFERENCES `managedSiteProvisioningPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningEvents` ADD CONSTRAINT `fk_managed_site_provisionin_step_id_5d821624ce` FOREIGN KEY (`stepId`) REFERENCES `managedSiteProvisioningSteps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD CONSTRAINT `managedSiteProvisioningPlans_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD CONSTRAINT `managedSiteProvisioningPlans_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD CONSTRAINT `managedSiteProvisioningPlans_versionId_managedSiteVersions_id_fk` FOREIGN KEY (`versionId`) REFERENCES `managedSiteVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningPlans` ADD CONSTRAINT `fk_managed_site_provisionin_domain_intent_id_35a0f6e70c` FOREIGN KEY (`domainIntentId`) REFERENCES `managedSiteDomainIntents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningSteps` ADD CONSTRAINT `managedSiteProvisioningSteps_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningSteps` ADD CONSTRAINT `managedSiteProvisioningSteps_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProvisioningSteps` ADD CONSTRAINT `fk_managed_site_provisionin_plan_id_d8f05090c1` FOREIGN KEY (`planId`) REFERENCES `managedSiteProvisioningPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_domain_intents_owner_status_idx` ON `managedSiteDomainIntents` (`ownerUserId`,`purchaseStatus`,`dnsStatus`);--> statement-breakpoint
CREATE INDEX `managed_site_provisioning_events_owner_plan_idx` ON `managedSiteProvisioningEvents` (`ownerUserId`,`planId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `managed_site_provisioning_plans_owner_status_idx` ON `managedSiteProvisioningPlans` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_provisioning_steps_owner_plan_status_idx` ON `managedSiteProvisioningSteps` (`ownerUserId`,`planId`,`status`);