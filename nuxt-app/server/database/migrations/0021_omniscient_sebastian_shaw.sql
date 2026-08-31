CREATE TABLE `managedSiteAssets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`assetHash` varchar(128) NOT NULL,
	`mimeType` varchar(160) NOT NULL,
	`byteSize` int NOT NULL,
	`purpose` varchar(120) NOT NULL,
	`storageReference` varchar(512) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteAssets_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_assets_project_hash_unique` UNIQUE(`projectId`,`assetHash`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteAuditEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`actorUserId` int,
	`authority` varchar(160) NOT NULL,
	`action` varchar(160) NOT NULL,
	`beforeFingerprint` varchar(128),
	`afterFingerprint` varchar(128),
	`eventFingerprint` varchar(128) NOT NULL,
	`metadata` json NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteAuditEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_audit_owner_event_unique` UNIQUE(`ownerUserId`,`eventFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteInvitations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`membershipId` int NOT NULL,
	`recipientEmail` varchar(320) NOT NULL,
	`role` enum('owner','administrator','editor','reviewer','analyst') NOT NULL,
	`tokenHash` varchar(128) NOT NULL,
	`status` enum('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending',
	`expiresAt` timestamp NOT NULL,
	`acceptedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteInvitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_invitations_token_hash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteMemberships` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`principalEmail` varchar(320) NOT NULL,
	`userId` int,
	`role` enum('owner','administrator','editor','reviewer','analyst') NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`invitedAt` timestamp NOT NULL DEFAULT (now()),
	`acceptedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteMemberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_memberships_project_email_unique` UNIQUE(`projectId`,`principalEmail`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteProjects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`canonicalClientIdentity` varchar(160) NOT NULL,
	`canonicalWebsiteIdentity` varchar(512) NOT NULL,
	`contentOperationClientId` int,
	`status` enum('draft','quoted','awaiting_customer_authorization','payment_pending','payment_verified','domain_intent_created','domain_purchase_pending','domain_registered','dns_pending','dns_verified','build_pending','building','deployment_failed','deployed','tls_pending','active','retry_wait','blocked','suspended') NOT NULL DEFAULT 'draft',
	`siteType` enum('one_page','brand_blog','simple_commerce') NOT NULL,
	`activeVersionId` int,
	`catalogVersion` varchar(96) NOT NULL,
	`subscriptionReference` varchar(160),
	`projectFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteProjects_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_projects_owner_client_identity_unique` UNIQUE(`ownerUserId`,`canonicalClientIdentity`),
	CONSTRAINT `managed_site_projects_owner_website_identity_unique` UNIQUE(`ownerUserId`,`canonicalWebsiteIdentity`),
	CONSTRAINT `managed_site_projects_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`projectFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`membershipId` int NOT NULL,
	`sessionHash` varchar(128) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp,
	CONSTRAINT `managedSiteSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_sessions_hash_unique` UNIQUE(`sessionHash`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteSubscriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`planKey` varchar(96) NOT NULL,
	`status` enum('active','past_due','grace_period','suspended','terminated') NOT NULL DEFAULT 'active',
	`subscriptionReference` varchar(160),
	`gracePeriodEndsAt` timestamp,
	`termEndsAt` timestamp,
	`idempotencyKey` varchar(128) NOT NULL,
	`stateFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteSubscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_subscriptions_project_unique` UNIQUE(`projectId`),
	CONSTRAINT `managed_site_subscriptions_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `managedSiteVersions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`version` int NOT NULL,
	`siteSpecSnapshot` json NOT NULL,
	`designTokenSnapshot` json NOT NULL,
	`selectedModuleSnapshot` json NOT NULL,
	`contentFingerprint` varchar(128) NOT NULL,
	`parentVersionId` int,
	`lifecycleStatus` enum('draft','preview','active','superseded','archived') NOT NULL DEFAULT 'draft',
	`createdByAuthority` varchar(160) NOT NULL,
	`versionFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_versions_project_version_unique` UNIQUE(`projectId`,`version`),
	CONSTRAINT `managed_site_versions_project_fingerprint_unique` UNIQUE(`projectId`,`versionFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteAssets` ADD CONSTRAINT `managedSiteAssets_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAssets` ADD CONSTRAINT `managedSiteAssets_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAuditEvents` ADD CONSTRAINT `managedSiteAuditEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAuditEvents` ADD CONSTRAINT `managedSiteAuditEvents_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteAuditEvents` ADD CONSTRAINT `managedSiteAuditEvents_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteInvitations` ADD CONSTRAINT `managedSiteInvitations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteInvitations` ADD CONSTRAINT `managedSiteInvitations_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteInvitations` ADD CONSTRAINT `managedSiteInvitations_membershipId_managedSiteMemberships_id_fk` FOREIGN KEY (`membershipId`) REFERENCES `managedSiteMemberships`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMemberships` ADD CONSTRAINT `managedSiteMemberships_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMemberships` ADD CONSTRAINT `managedSiteMemberships_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteMemberships` ADD CONSTRAINT `managedSiteMemberships_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProjects` ADD CONSTRAINT `managedSiteProjects_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteProjects` ADD CONSTRAINT `fk_managed_site_projects_content_operation__50e755d3c5` FOREIGN KEY (`contentOperationClientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteSessions` ADD CONSTRAINT `managedSiteSessions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteSessions` ADD CONSTRAINT `managedSiteSessions_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteSessions` ADD CONSTRAINT `managedSiteSessions_membershipId_managedSiteMemberships_id_fk` FOREIGN KEY (`membershipId`) REFERENCES `managedSiteMemberships`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteSubscriptions` ADD CONSTRAINT `managedSiteSubscriptions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteSubscriptions` ADD CONSTRAINT `managedSiteSubscriptions_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteVersions` ADD CONSTRAINT `managedSiteVersions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteVersions` ADD CONSTRAINT `managedSiteVersions_projectId_managedSiteProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_assets_owner_project_idx` ON `managedSiteAssets` (`ownerUserId`,`projectId`);--> statement-breakpoint
CREATE INDEX `managed_site_audit_owner_project_time_idx` ON `managedSiteAuditEvents` (`ownerUserId`,`projectId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `managed_site_invitations_owner_project_status_idx` ON `managedSiteInvitations` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_memberships_owner_project_status_idx` ON `managedSiteMemberships` (`ownerUserId`,`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_projects_owner_status_idx` ON `managedSiteProjects` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_sessions_owner_project_idx` ON `managedSiteSessions` (`ownerUserId`,`projectId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `managed_site_subscriptions_owner_status_idx` ON `managedSiteSubscriptions` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `managed_site_versions_owner_project_idx` ON `managedSiteVersions` (`ownerUserId`,`projectId`,`createdAt`);