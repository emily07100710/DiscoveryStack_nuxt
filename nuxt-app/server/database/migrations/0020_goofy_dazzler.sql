CREATE TABLE `contentOperationMeasurementConnections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`publicationTargetId` int,
	`websiteIdentity` varchar(160) NOT NULL,
	`source` enum('google_search_console','first_party_analytics','llm_visibility') NOT NULL,
	`activeSource` enum('google_search_console','first_party_analytics','llm_visibility'),
	`status` enum('configured','paused','revoked','needs_reauthorization') NOT NULL DEFAULT 'configured',
	`credentialReference` varchar(128),
	`googleSearchConsoleProperty` varchar(2048),
	`ga4PropertyId` varchar(12),
	`llmVisibilityProjectId` int,
	`canonicalOrigin` varchar(2048) NOT NULL,
	`timeZone` varchar(80) NOT NULL,
	`allowedPageScope` json NOT NULL,
	`sourceAvailabilityLagDays` int NOT NULL DEFAULT 0,
	`providerTargets` json,
	`idempotencyKey` varchar(128) NOT NULL,
	`configurationFingerprint` varchar(128) NOT NULL,
	`connectedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationMeasurementConnections_id` PRIMARY KEY(`id`),
	CONSTRAINT `measurement_connections_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `measurement_connections_owner_website_active_source_unique` UNIQUE(`ownerUserId`,`websiteIdentity`,`activeSource`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationMeasurementRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`connectionId` int NOT NULL,
	`entryId` int NOT NULL,
	`targetId` int NOT NULL,
	`source` enum('google_search_console','first_party_analytics','llm_visibility') NOT NULL,
	`checkpointDays` int NOT NULL,
	`publicationReceiptFingerprint` varchar(128) NOT NULL,
	`canonicalPage` varchar(2048) NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`publicationLocalDate` varchar(10) NOT NULL,
	`timeZone` varchar(80) NOT NULL,
	`baselineWindowStart` timestamp NOT NULL,
	`baselineWindowEnd` timestamp NOT NULL,
	`followUpWindowStart` timestamp NOT NULL,
	`followUpWindowEnd` timestamp NOT NULL,
	`dueAt` timestamp NOT NULL,
	`state` enum('queued','processing','retry_wait','succeeded','insufficient_data','blocked','failed','cancelled') NOT NULL DEFAULT 'queued',
	`attemptNumber` int NOT NULL DEFAULT 0,
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`retryEligibleAt` timestamp,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`outputFingerprint` varchar(128),
	`errorCode` varchar(120),
	`errorSummary` varchar(500),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationMeasurementRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `measurement_runs_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `measurement_runs_owner_pair_unique` UNIQUE(`ownerUserId`,`entryId`,`targetId`,`source`,`checkpointDays`,`baselineWindowStart`,`followUpWindowStart`,`publicationReceiptFingerprint`,`contentHash`,`evidenceSnapshotHash`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationMeasurementSnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`runId` int NOT NULL,
	`entryId` int NOT NULL,
	`targetId` int NOT NULL,
	`source` enum('google_search_console','first_party_analytics','llm_visibility') NOT NULL,
	`phase` enum('baseline','follow_up') NOT NULL,
	`deidentifiedSubjectKey` varchar(64) NOT NULL,
	`scopeFingerprint` varchar(128) NOT NULL,
	`windowStart` timestamp NOT NULL,
	`windowEnd` timestamp NOT NULL,
	`capturedAt` timestamp NOT NULL,
	`sourceHash` varchar(128) NOT NULL,
	`normalizedMetrics` json NOT NULL,
	`providerProvenance` json NOT NULL,
	`limitations` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationMeasurementSnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `measurement_snapshots_run_phase_unique` UNIQUE(`runId`,`phase`),
	CONSTRAINT `measurement_snapshots_owner_source_hash_unique` UNIQUE(`ownerUserId`,`sourceHash`)
);
--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementConnections` ADD CONSTRAINT `contentOperationMeasurementConnections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementConnections` ADD CONSTRAINT `fk_content_operation_measur_client_id_1c83d5c87a` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementConnections` ADD CONSTRAINT `fk_content_operation_measur_publication_target_e132211c28` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementConnections` ADD CONSTRAINT `fk_content_operation_measur_llm_visibility_pro_68a85804ca` FOREIGN KEY (`llmVisibilityProjectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementRuns` ADD CONSTRAINT `contentOperationMeasurementRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementRuns` ADD CONSTRAINT `fk_content_operation_measur_client_id_7c3a0db31b` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementRuns` ADD CONSTRAINT `fk_content_operation_measur_connection_id_641abb194f` FOREIGN KEY (`connectionId`) REFERENCES `contentOperationMeasurementConnections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementRuns` ADD CONSTRAINT `fk_content_operation_measur_entry_id_013f78a580` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementRuns` ADD CONSTRAINT `fk_content_operation_measur_target_id_9f6e02f2b0` FOREIGN KEY (`targetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementSnapshots` ADD CONSTRAINT `contentOperationMeasurementSnapshots_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementSnapshots` ADD CONSTRAINT `fk_content_operation_measur_run_id_96920fa3da` FOREIGN KEY (`runId`) REFERENCES `contentOperationMeasurementRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementSnapshots` ADD CONSTRAINT `fk_content_operation_measur_entry_id_f920c00179` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationMeasurementSnapshots` ADD CONSTRAINT `fk_content_operation_measur_target_id_de4fc33e99` FOREIGN KEY (`targetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `measurement_connections_owner_status_idx` ON `contentOperationMeasurementConnections` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `measurement_connections_owner_client_idx` ON `contentOperationMeasurementConnections` (`ownerUserId`,`clientId`);--> statement-breakpoint
CREATE INDEX `measurement_runs_owner_due_idx` ON `contentOperationMeasurementRuns` (`ownerUserId`,`state`,`dueAt`);--> statement-breakpoint
CREATE INDEX `measurement_runs_connection_idx` ON `contentOperationMeasurementRuns` (`connectionId`,`state`);--> statement-breakpoint
CREATE INDEX `measurement_runs_entry_checkpoint_idx` ON `contentOperationMeasurementRuns` (`ownerUserId`,`entryId`,`checkpointDays`);--> statement-breakpoint
CREATE INDEX `measurement_runs_lease_idx` ON `contentOperationMeasurementRuns` (`state`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `measurement_snapshots_owner_entry_idx` ON `contentOperationMeasurementSnapshots` (`ownerUserId`,`entryId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `measurement_snapshots_run_idx` ON `contentOperationMeasurementSnapshots` (`runId`);
