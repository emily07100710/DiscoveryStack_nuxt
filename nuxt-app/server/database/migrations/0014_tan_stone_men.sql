CREATE TABLE `contentOperationCalendarEntries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`calendarId` int NOT NULL,
	`productionDeliverableId` int NOT NULL,
	`strategyRecommendationId` int NOT NULL,
	`jobId` int,
	`draftId` int,
	`reviewId` int,
	`scheduleKey` varchar(180) NOT NULL,
	`plannedLocalDate` varchar(10) NOT NULL,
	`publishLocalTime` varchar(5) NOT NULL,
	`timeZone` varchar(80) NOT NULL,
	`contentType` enum('article','faq','service_page') NOT NULL,
	`language` enum('en','zh-hant') NOT NULL,
	`topicCluster` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`contentHash` varchar(128),
	`status` enum('planned','materialized','awaiting_generation','awaiting_review','ready_to_publish','publishing','delivered','completed','cancelled','skipped','blocked') NOT NULL DEFAULT 'planned',
	`engineEntryId` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationCalendarEntries_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_entries_calendar_engine_unique` UNIQUE(`calendarId`,`engineEntryId`),
	CONSTRAINT `content_operation_entries_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationCalendars` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`productionPlanId` int NOT NULL,
	`engineVersion` varchar(96) NOT NULL,
	`status` enum('ready','partial','blocked','paused','archived') NOT NULL DEFAULT 'ready',
	`planStartDate` varchar(10) NOT NULL,
	`planEndDate` varchar(10) NOT NULL,
	`timeZone` varchar(80) NOT NULL,
	`publishLocalTime` varchar(5) NOT NULL,
	`cadenceDays` int NOT NULL,
	`monthlyBudgetUnits` int NOT NULL,
	`defaultCostUnits` int NOT NULL,
	`maxItemsPerCalendarMonth` int NOT NULL,
	`maximumTotalItems` int NOT NULL,
	`catchUpPolicy` enum('skip_missed','one_catch_up') NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`revision` int NOT NULL,
	`previousPlanFingerprint` varchar(128),
	`planFingerprint` varchar(128) NOT NULL,
	`normalizedRequestSnapshot` json NOT NULL,
	`resultSnapshot` json NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationCalendars_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_calendars_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationClients` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`displayName` varchar(160) NOT NULL,
	`canonicalSiteOrigin` varchar(512) NOT NULL,
	`framework` enum('astro','nuxt') NOT NULL,
	`publicationTransport` enum('first_party_git','first_party_signed_api') NOT NULL,
	`timeZone` varchar(80) NOT NULL,
	`defaultCadenceDays` int NOT NULL,
	`defaultPublishLocalTime` varchar(5) NOT NULL,
	`monthlyBudgetUnits` int NOT NULL,
	`status` enum('active','paused','archived') NOT NULL DEFAULT 'active',
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationClients_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_clients_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `content_operation_clients_owner_origin_unique` UNIQUE(`ownerUserId`,`canonicalSiteOrigin`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int,
	`calendarId` int,
	`entryId` int,
	`runId` int,
	`eventType` varchar(120) NOT NULL,
	`fromStatus` varchar(80),
	`toStatus` varchar(80),
	`eventFingerprint` varchar(128) NOT NULL,
	`metadata` json NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_events_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`eventFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationOutcomeAssessments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`entryId` int NOT NULL,
	`runId` int,
	`assessmentStatus` varchar(40) NOT NULL,
	`assessmentFingerprint` varchar(128) NOT NULL,
	`baselineSnapshot` json NOT NULL,
	`followUpSnapshot` json NOT NULL,
	`assessmentSnapshot` json NOT NULL,
	`consentLineageSnapshot` json NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`measuredAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationOutcomeAssessments_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_outcomes_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `contentOperationRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`entryId` int NOT NULL,
	`stage` enum('generation','review_wait','publication','measurement','learning') NOT NULL,
	`state` enum('queued','processing','retry_wait','succeeded','failed','blocked','cancelled') NOT NULL DEFAULT 'queued',
	`attemptNumber` int NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`outputFingerprint` varchar(128),
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`retryEligibleAt` timestamp,
	`errorCode` varchar(120),
	`errorSummary` varchar(500),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_runs_owner_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `contentOperationCalendarEntries_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `fk_content_operation_calend_calendar_id_c72ad0a558` FOREIGN KEY (`calendarId`) REFERENCES `contentOperationCalendars`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `fk_content_operation_calend_production_deliver_cbdb622479` FOREIGN KEY (`productionDeliverableId`) REFERENCES `seoGeoProductionDeliverables`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `fk_content_operation_calend_strategy_recommend_03ed594f59` FOREIGN KEY (`strategyRecommendationId`) REFERENCES `seoGeoStrategyRecommendations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `contentOperationCalendarEntries_jobId_seoGeoContentJobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `seoGeoContentJobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `fk_content_operation_calend_draft_id_8868b4ffaf` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD CONSTRAINT `fk_content_operation_calend_review_id_e20eb7911f` FOREIGN KEY (`reviewId`) REFERENCES `seoGeoContentReviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendars` ADD CONSTRAINT `contentOperationCalendars_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendars` ADD CONSTRAINT `contentOperationCalendars_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendars` ADD CONSTRAINT `fk_content_operation_calend_production_plan_id_b42f43cf58` FOREIGN KEY (`productionPlanId`) REFERENCES `seoGeoProductionPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationClients` ADD CONSTRAINT `contentOperationClients_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD CONSTRAINT `contentOperationEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD CONSTRAINT `contentOperationEvents_clientId_contentOperationClients_id_fk` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD CONSTRAINT `fk_content_operation_events_calendar_id_d06bc3e5a5` FOREIGN KEY (`calendarId`) REFERENCES `contentOperationCalendars`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD CONSTRAINT `fk_content_operation_events_entry_id_daf7597de3` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD CONSTRAINT `contentOperationEvents_runId_contentOperationRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `contentOperationRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD CONSTRAINT `contentOperationOutcomeAssessments_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD CONSTRAINT `fk_content_operation_outcom_entry_id_d4105827c1` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD CONSTRAINT `fk_content_operation_outcom_run_id_460792842c` FOREIGN KEY (`runId`) REFERENCES `contentOperationRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationRuns` ADD CONSTRAINT `contentOperationRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationRuns` ADD CONSTRAINT `fk_content_operation_runs_entry_id_ae4a0120d9` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `content_operation_entries_owner_status_idx` ON `contentOperationCalendarEntries` (`ownerUserId`,`status`,`plannedLocalDate`);--> statement-breakpoint
CREATE INDEX `content_operation_entries_calendar_status_idx` ON `contentOperationCalendarEntries` (`calendarId`,`status`);--> statement-breakpoint
CREATE INDEX `content_operation_calendars_owner_fingerprint_idx` ON `contentOperationCalendars` (`ownerUserId`,`planFingerprint`);--> statement-breakpoint
CREATE INDEX `content_operation_calendars_owner_status_idx` ON `contentOperationCalendars` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `content_operation_clients_owner_status_idx` ON `contentOperationClients` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `content_operation_events_owner_occurred_idx` ON `contentOperationEvents` (`ownerUserId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `content_operation_events_entry_idx` ON `contentOperationEvents` (`entryId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `content_operation_outcomes_entry_idx` ON `contentOperationOutcomeAssessments` (`entryId`,`measuredAt`);--> statement-breakpoint
CREATE INDEX `content_operation_runs_entry_stage_idx` ON `contentOperationRuns` (`entryId`,`stage`,`state`);--> statement-breakpoint
CREATE INDEX `content_operation_runs_lease_idx` ON `contentOperationRuns` (`entryId`,`stage`,`leaseExpiresAt`);