CREATE TABLE `systemAdminInvitations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invitationId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`principalEmailHash` varchar(64) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`roleKey` varchar(64) NOT NULL,
	`status` enum('pending','accepted','expired','revoked') NOT NULL DEFAULT 'pending',
	`expiresAt` timestamp NOT NULL,
	`acceptedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemAdminInvitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_admin_invitations_public_id_unique` UNIQUE(`invitationId`),
	CONSTRAINT `system_admin_invitations_token_hash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `systemConnectionRefs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`connectionRefId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`purpose` enum('frappe_internal_hmac','frappe_site_admin','backup_storage','email','calendar','content_projection') NOT NULL,
	`opaqueReference` varchar(192) NOT NULL,
	`status` enum('active','revoked','unavailable') NOT NULL DEFAULT 'active',
	`referenceFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`revokedAt` timestamp,
	CONSTRAINT `systemConnectionRefs_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_connection_refs_public_id_unique` UNIQUE(`connectionRefId`),
	CONSTRAINT `system_connection_refs_tenant_purpose_unique` UNIQUE(`systemTenantId`,`purpose`),
	CONSTRAINT `system_connection_refs_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`referenceFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `systemEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`previousState` varchar(48) NOT NULL,
	`nextState` varchar(48) NOT NULL,
	`eventType` varchar(96) NOT NULL,
	`authorityFingerprint` varchar(64) NOT NULL,
	`payloadFingerprint` varchar(64) NOT NULL,
	`eventFingerprint` varchar(64) NOT NULL,
	`occurredAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_events_public_id_unique` UNIQUE(`eventId`),
	CONSTRAINT `system_events_fingerprint_unique` UNIQUE(`eventFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `systemPreviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`previewId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemSpecId` int NOT NULL,
	`systemSpecVersionId` int NOT NULL,
	`managedSitePreviewId` int,
	`version` int NOT NULL,
	`parentPreviewId` int,
	`specFingerprint` varchar(64) NOT NULL,
	`fixtureFingerprint` varchar(64) NOT NULL,
	`compiledPlanFingerprint` varchar(64) NOT NULL,
	`fixtureProjection` json NOT NULL,
	`status` enum('preview_ready','superseded','expired') NOT NULL DEFAULT 'preview_ready',
	`noProductionData` boolean NOT NULL DEFAULT true,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemPreviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_previews_public_id_unique` UNIQUE(`previewId`),
	CONSTRAINT `system_previews_spec_version_unique` UNIQUE(`systemSpecId`,`version`),
	CONSTRAINT `system_previews_spec_fixture_unique` UNIQUE(`systemSpecVersionId`,`fixtureFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `systemProvisioningAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`runId` int NOT NULL,
	`operation` enum('create_site','install_app','apply_compiled_spec','create_roles_permissions','configure_modules','health_check','create_admin_invitation','suspend_site','reactivate_site','deprovision_site') NOT NULL,
	`attemptNumber` int NOT NULL,
	`status` enum('processing','succeeded','retry_wait','failed','blocked') NOT NULL,
	`timeoutMs` int NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`responseFingerprint` varchar(64),
	`exactResponseIdentity` varchar(256),
	`errorCode` varchar(96),
	`errorSummary` varchar(500),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `systemProvisioningAttempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_provisioning_attempt_run_operation_unique` UNIQUE(`runId`,`operation`,`attemptNumber`)
);
--> statement-breakpoint
CREATE TABLE `systemProvisioningPlans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`planId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`systemSpecVersionId` int NOT NULL,
	`planFingerprint` varchar(64) NOT NULL,
	`steps` json NOT NULL,
	`status` enum('planned','running','retry_wait','failed','health_checking','invitation_pending','completed','cancelled') NOT NULL DEFAULT 'planned',
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `systemProvisioningPlans_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_provisioning_plans_public_id_unique` UNIQUE(`planId`),
	CONSTRAINT `system_provisioning_plans_owner_key_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `system_provisioning_plans_tenant_fingerprint_unique` UNIQUE(`systemTenantId`,`planFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `systemProvisioningRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`planId` int NOT NULL,
	`status` enum('queued','processing','retry_wait','failed','blocked','completed') NOT NULL DEFAULT 'queued',
	`attempt` int NOT NULL DEFAULT 0,
	`maxAttempts` int NOT NULL DEFAULT 3,
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`retryEligibleAt` timestamp,
	`inputFingerprint` varchar(64) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `systemProvisioningRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_provisioning_runs_public_id_unique` UNIQUE(`runId`),
	CONSTRAINT `system_provisioning_runs_owner_key_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `systemReceipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`receiptId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`runId` int,
	`receiptType` varchar(96) NOT NULL,
	`status` enum('verified','failed','blocked','rolled_back','replayed') NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`responseFingerprint` varchar(64),
	`exactResponseIdentity` varchar(256),
	`metadata` json NOT NULL,
	`receiptFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemReceipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_receipts_public_id_unique` UNIQUE(`receiptId`),
	CONSTRAINT `system_receipts_fingerprint_unique` UNIQUE(`ownerUserId`,`receiptFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `systemSpecVersions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemSpecId` int NOT NULL,
	`version` int NOT NULL,
	`parentVersionId` int,
	`parentFingerprint` varchar(64),
	`schemaVersion` varchar(64) NOT NULL,
	`compilerVersion` varchar(64) NOT NULL,
	`normalizedSpec` json NOT NULL,
	`compiledPlan` json NOT NULL,
	`specFingerprint` varchar(64) NOT NULL,
	`compiledPlanFingerprint` varchar(64) NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdByAuthority` varchar(96) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemSpecVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_spec_versions_spec_version_unique` UNIQUE(`systemSpecId`,`version`),
	CONSTRAINT `system_spec_versions_spec_fingerprint_unique` UNIQUE(`systemSpecId`,`specFingerprint`),
	CONSTRAINT `system_spec_versions_owner_key_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `systemSpecs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`specId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`websiteId` varchar(128),
	`managedSiteProjectId` int,
	`activeVersionId` int,
	`status` enum('draft','preview_ready','quote_ready','awaiting_payment','payment_verified','provisioning_planned','provisioning','health_checking','invitation_pending','active','failed','retry_wait','suspended','deprovision_pending','deprovisioned') NOT NULL DEFAULT 'draft',
	`identityFingerprint` varchar(64) NOT NULL,
	`creationIdempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `systemSpecs_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_specs_owner_spec_unique` UNIQUE(`ownerUserId`,`specId`),
	CONSTRAINT `system_specs_owner_identity_unique` UNIQUE(`ownerUserId`,`identityFingerprint`),
	CONSTRAINT `system_specs_owner_creation_key_unique` UNIQUE(`ownerUserId`,`creationIdempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `systemTenantBindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`clientId` int NOT NULL,
	`websiteId` varchar(128),
	`managedSiteProjectId` int,
	`managedSitePreviewId` int,
	`managedSiteQuoteId` int,
	`managedSiteDraftOrderId` int,
	`managedSitePaymentEventId` int,
	`bindingFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemTenantBindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_tenant_bindings_tenant_unique` UNIQUE(`systemTenantId`),
	CONSTRAINT `system_tenant_bindings_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`bindingFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `systemTenants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`systemTenantId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`systemSpecId` int NOT NULL,
	`systemSpecVersionId` int NOT NULL,
	`siteNameHash` varchar(64) NOT NULL,
	`state` enum('draft','preview_ready','quote_ready','awaiting_payment','payment_verified','provisioning_planned','provisioning','health_checking','invitation_pending','active','failed','retry_wait','suspended','deprovision_pending','deprovisioned') NOT NULL DEFAULT 'draft',
	`stateVersion` int NOT NULL DEFAULT 1,
	`specFingerprint` varchar(64) NOT NULL,
	`compiledPlanFingerprint` varchar(64) NOT NULL,
	`verifiedPaymentReceiptFingerprint` varchar(64),
	`healthyReceiptFingerprint` varchar(64),
	`invitationReceiptFingerprint` varchar(64),
	`projectionFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deprovisionedAt` timestamp,
	CONSTRAINT `systemTenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_tenants_public_id_unique` UNIQUE(`systemTenantId`),
	CONSTRAINT `system_tenants_spec_unique` UNIQUE(`systemSpecId`),
	CONSTRAINT `system_tenants_owner_site_hash_unique` UNIQUE(`ownerUserId`,`siteNameHash`)
);
--> statement-breakpoint
CREATE TABLE `systemUpgradeIntents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`upgradeIntentId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`fromVersionLockHash` varchar(64) NOT NULL,
	`toVersionLockHash` varchar(64) NOT NULL,
	`reviewedByUserId` int NOT NULL,
	`status` enum('draft','reviewed','planned','running','completed','failed','rolled_back','cancelled') NOT NULL DEFAULT 'draft',
	`intentFingerprint` varchar(64) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `systemUpgradeIntents_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_upgrade_intents_public_id_unique` UNIQUE(`upgradeIntentId`),
	CONSTRAINT `system_upgrade_intents_owner_key_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `system_upgrade_intents_tenant_fingerprint_unique` UNIQUE(`systemTenantId`,`intentFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `systemUpgradeReceipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`receiptId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`upgradeRunId` int NOT NULL,
	`step` enum('plan','backup','apply','verify','rollback') NOT NULL,
	`status` enum('verified','failed','rolled_back') NOT NULL,
	`artifactFingerprint` varchar(64),
	`receiptFingerprint` varchar(64) NOT NULL,
	`exactResponseIdentity` varchar(256),
	`metadata` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemUpgradeReceipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_upgrade_receipts_public_id_unique` UNIQUE(`receiptId`),
	CONSTRAINT `system_upgrade_receipts_fingerprint_unique` UNIQUE(`ownerUserId`,`receiptFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `systemUpgradeRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`upgradeRunId` varchar(128) NOT NULL,
	`ownerUserId` int NOT NULL,
	`systemTenantId` int NOT NULL,
	`upgradeIntentId` int NOT NULL,
	`status` enum('queued','backing_up','applying','verifying','completed','failed','rolling_back','rolled_back') NOT NULL DEFAULT 'queued',
	`attempt` int NOT NULL DEFAULT 0,
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`backupReceiptFingerprint` varchar(64),
	`rollbackReceiptFingerprint` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `systemUpgradeRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_upgrade_runs_public_id_unique` UNIQUE(`upgradeRunId`)
);
--> statement-breakpoint
ALTER TABLE `systemAdminInvitations` ADD CONSTRAINT `systemAdminInvitations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemAdminInvitations` ADD CONSTRAINT `systemAdminInvitations_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemConnectionRefs` ADD CONSTRAINT `systemConnectionRefs_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemConnectionRefs` ADD CONSTRAINT `systemConnectionRefs_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemEvents` ADD CONSTRAINT `systemEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemEvents` ADD CONSTRAINT `systemEvents_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemPreviews` ADD CONSTRAINT `systemPreviews_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemPreviews` ADD CONSTRAINT `systemPreviews_systemSpecId_systemSpecs_id_fk` FOREIGN KEY (`systemSpecId`) REFERENCES `systemSpecs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemPreviews` ADD CONSTRAINT `systemPreviews_systemSpecVersionId_systemSpecVersions_id_fk` FOREIGN KEY (`systemSpecVersionId`) REFERENCES `systemSpecVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemPreviews` ADD CONSTRAINT `systemPreviews_managedSitePreviewId_managedSitePreviews_id_fk` FOREIGN KEY (`managedSitePreviewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningAttempts` ADD CONSTRAINT `systemProvisioningAttempts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningAttempts` ADD CONSTRAINT `systemProvisioningAttempts_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningAttempts` ADD CONSTRAINT `systemProvisioningAttempts_runId_systemProvisioningRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `systemProvisioningRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningPlans` ADD CONSTRAINT `systemProvisioningPlans_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningPlans` ADD CONSTRAINT `systemProvisioningPlans_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningPlans` ADD CONSTRAINT `systemProvisioningPlans_systemSpecVersionId_systemSpecVersions_id_fk` FOREIGN KEY (`systemSpecVersionId`) REFERENCES `systemSpecVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningRuns` ADD CONSTRAINT `systemProvisioningRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningRuns` ADD CONSTRAINT `systemProvisioningRuns_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemProvisioningRuns` ADD CONSTRAINT `systemProvisioningRuns_planId_systemProvisioningPlans_id_fk` FOREIGN KEY (`planId`) REFERENCES `systemProvisioningPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemReceipts` ADD CONSTRAINT `systemReceipts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemReceipts` ADD CONSTRAINT `systemReceipts_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemReceipts` ADD CONSTRAINT `systemReceipts_runId_systemProvisioningRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `systemProvisioningRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemSpecVersions` ADD CONSTRAINT `systemSpecVersions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemSpecVersions` ADD CONSTRAINT `systemSpecVersions_systemSpecId_systemSpecs_id_fk` FOREIGN KEY (`systemSpecId`) REFERENCES `systemSpecs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemSpecs` ADD CONSTRAINT `systemSpecs_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemSpecs` ADD CONSTRAINT `systemSpecs_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemSpecs` ADD CONSTRAINT `systemSpecs_managedSiteProjectId_managedSiteProjects_id_fk` FOREIGN KEY (`managedSiteProjectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenantBindings` ADD CONSTRAINT `systemTenantBindings_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenantBindings` ADD CONSTRAINT `systemTenantBindings_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenantBindings` ADD CONSTRAINT `systemTenantBindings_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenantBindings` ADD CONSTRAINT `systemTenantBindings_managedSiteProjectId_managedSiteProjects_id_fk` FOREIGN KEY (`managedSiteProjectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenantBindings` ADD CONSTRAINT `systemTenantBindings_managedSitePreviewId_managedSitePreviews_id_fk` FOREIGN KEY (`managedSitePreviewId`) REFERENCES `managedSitePreviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenantBindings` ADD CONSTRAINT `systemTenantBindings_managedSiteQuoteId_managedSiteQuotes_id_fk` FOREIGN KEY (`managedSiteQuoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenantBindings` ADD CONSTRAINT `systemTenantBindings_managedSiteDraftOrderId_managedSiteDraftOrders_id_fk` FOREIGN KEY (`managedSiteDraftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenantBindings` ADD CONSTRAINT `systemTenantBindings_managedSitePaymentEventId_managedSitePaymentEvents_id_fk` FOREIGN KEY (`managedSitePaymentEventId`) REFERENCES `managedSitePaymentEvents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenants` ADD CONSTRAINT `systemTenants_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenants` ADD CONSTRAINT `systemTenants_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenants` ADD CONSTRAINT `systemTenants_systemSpecId_systemSpecs_id_fk` FOREIGN KEY (`systemSpecId`) REFERENCES `systemSpecs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemTenants` ADD CONSTRAINT `systemTenants_systemSpecVersionId_systemSpecVersions_id_fk` FOREIGN KEY (`systemSpecVersionId`) REFERENCES `systemSpecVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeIntents` ADD CONSTRAINT `systemUpgradeIntents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeIntents` ADD CONSTRAINT `systemUpgradeIntents_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeIntents` ADD CONSTRAINT `systemUpgradeIntents_reviewedByUserId_users_id_fk` FOREIGN KEY (`reviewedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeReceipts` ADD CONSTRAINT `systemUpgradeReceipts_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeReceipts` ADD CONSTRAINT `systemUpgradeReceipts_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeReceipts` ADD CONSTRAINT `systemUpgradeReceipts_upgradeRunId_systemUpgradeRuns_id_fk` FOREIGN KEY (`upgradeRunId`) REFERENCES `systemUpgradeRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeRuns` ADD CONSTRAINT `systemUpgradeRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeRuns` ADD CONSTRAINT `systemUpgradeRuns_systemTenantId_systemTenants_id_fk` FOREIGN KEY (`systemTenantId`) REFERENCES `systemTenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `systemUpgradeRuns` ADD CONSTRAINT `systemUpgradeRuns_upgradeIntentId_systemUpgradeIntents_id_fk` FOREIGN KEY (`upgradeIntentId`) REFERENCES `systemUpgradeIntents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `system_admin_invitations_tenant_status_idx` ON `systemAdminInvitations` (`ownerUserId`,`systemTenantId`,`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `system_events_tenant_created_idx` ON `systemEvents` (`ownerUserId`,`systemTenantId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `system_previews_owner_status_idx` ON `systemPreviews` (`ownerUserId`,`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `system_provisioning_attempt_tenant_status_idx` ON `systemProvisioningAttempts` (`ownerUserId`,`systemTenantId`,`status`);--> statement-breakpoint
CREATE INDEX `system_provisioning_plans_owner_status_idx` ON `systemProvisioningPlans` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `system_provisioning_runs_lease_idx` ON `systemProvisioningRuns` (`status`,`leaseExpiresAt`,`retryEligibleAt`);--> statement-breakpoint
CREATE INDEX `system_receipts_tenant_created_idx` ON `systemReceipts` (`ownerUserId`,`systemTenantId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `system_spec_versions_owner_spec_idx` ON `systemSpecVersions` (`ownerUserId`,`systemSpecId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `system_specs_owner_client_status_idx` ON `systemSpecs` (`ownerUserId`,`clientId`,`status`);--> statement-breakpoint
CREATE INDEX `system_tenant_bindings_commerce_idx` ON `systemTenantBindings` (`managedSiteDraftOrderId`,`managedSitePaymentEventId`);--> statement-breakpoint
CREATE INDEX `system_tenants_owner_client_state_idx` ON `systemTenants` (`ownerUserId`,`clientId`,`state`);--> statement-breakpoint
CREATE INDEX `system_upgrade_receipts_run_step_idx` ON `systemUpgradeReceipts` (`upgradeRunId`,`step`,`createdAt`);--> statement-breakpoint
CREATE INDEX `system_upgrade_runs_tenant_status_idx` ON `systemUpgradeRuns` (`ownerUserId`,`systemTenantId`,`status`);--> statement-breakpoint
CREATE INDEX `system_upgrade_runs_lease_idx` ON `systemUpgradeRuns` (`status`,`leaseExpiresAt`);