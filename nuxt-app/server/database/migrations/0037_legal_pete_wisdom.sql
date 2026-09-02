CREATE TABLE `experimentResults` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`experimentId` int NOT NULL,
	`interventionId` int,
	`resultKind` enum('pre_post','grouped_difference') NOT NULL,
	`metric` varchar(40) NOT NULL,
	`sampleSizeBaseline` int NOT NULL,
	`sampleSizeFollowUp` int NOT NULL,
	`effect` json NOT NULL,
	`signal` enum('positive_signal','negative_signal','no_material_change','mixed_signal','insufficient_data') NOT NULL,
	`limitations` json NOT NULL,
	`causalStatement` text NOT NULL,
	`computedAt` timestamp NOT NULL,
	`resultFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `experimentResults_id` PRIMARY KEY(`id`),
	CONSTRAINT `exp_results_owner_fp_uq` UNIQUE(`ownerUserId`,`resultFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `interventionEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`interventionId` int NOT NULL,
	`eventType` varchar(64) NOT NULL,
	`fromStatus` varchar(32),
	`toStatus` varchar(32),
	`evidence` json NOT NULL,
	`evidenceFingerprint` varchar(64) NOT NULL,
	`occurredAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `interventionEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `interventionExperiments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`design` enum('pre_post','grouped') NOT NULL,
	`hypothesis` text,
	`status` enum('draft','running','concluded') NOT NULL DEFAULT 'draft',
	`primaryMetric` enum('clicks','impressions','ctr','averagePosition') NOT NULL DEFAULT 'clicks',
	`startedAt` timestamp,
	`concludedAt` timestamp,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `interventionExperiments_id` PRIMARY KEY(`id`),
	CONSTRAINT `intv_exp_owner_key_uq` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `interventionMeasurements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`interventionId` int NOT NULL,
	`origin` enum('system_pulled','manual') NOT NULL,
	`source` enum('google_search_console','llm_visibility','first_party_analytics','lead_conversion') NOT NULL,
	`windowStart` timestamp NOT NULL,
	`windowEnd` timestamp NOT NULL,
	`metrics` json NOT NULL,
	`sampleSize` int NOT NULL,
	`sourceHash` varchar(64) NOT NULL,
	`capturedAt` timestamp NOT NULL,
	`property` varchar(255),
	`pullReason` enum('owner_request','scheduled_tick'),
	`note` varchar(500),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `interventionMeasurements_id` PRIMARY KEY(`id`),
	CONSTRAINT `intv_meas_window_uq` UNIQUE(`ownerUserId`,`interventionId`,`origin`,`source`,`windowStart`,`windowEnd`)
);
--> statement-breakpoint
CREATE TABLE `interventions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`targetUrl` varchar(2048) NOT NULL,
	`normalizedUrl` varchar(2048) NOT NULL,
	`urlHash` varchar(64) NOT NULL,
	`siteHost` varchar(255) NOT NULL,
	`briefId` int,
	`draftId` int,
	`entryId` int,
	`targetId` int,
	`interventionType` enum('content_update','new_page','structured_data','internal_linking','technical','entity_claim','other') NOT NULL,
	`changeSummary` varchar(1000) NOT NULL,
	`hypothesis` text,
	`expectedImpact` json,
	`expectedSnippet` varchar(500),
	`registrationSource` enum('manual','content_operations_delivery','outcome_assessment') NOT NULL,
	`status` enum('registered','deployed','recrawl_confirmed','measured','assessed','cancelled') NOT NULL DEFAULT 'registered',
	`baselineContentHash` varchar(64),
	`baselineHashSource` enum('site_evidence_inventory','live_fetch','content_operations'),
	`baselineCapturedAt` timestamp,
	`deployedAt` timestamp,
	`deployEvidenceLevel` enum('strong','weak'),
	`deployEvidenceSource` enum('expected_snippet','fingerprint_change','manual','publication_receipt','site_evidence_scan'),
	`deployedContentHash` varchar(64),
	`deploymentNote` varchar(1000),
	`recrawlStatus` enum('not_checked','unknown','confirmed') NOT NULL DEFAULT 'not_checked',
	`recrawlConfirmedAt` timestamp,
	`recrawlSource` enum('gsc_url_inspection','manual'),
	`recrawlLastCrawlTime` timestamp,
	`recrawlNote` varchar(1000),
	`recrawlAutoAttempts` int NOT NULL DEFAULT 0,
	`recrawlLastAutoAttemptAt` timestamp,
	`recrawlAutoFailureCount` int NOT NULL DEFAULT 0,
	`recrawlAutoFailureDay` varchar(10),
	`recrawlLastReason` varchar(120),
	`measuredAt` timestamp,
	`assessedAt` timestamp,
	`cancelledAt` timestamp,
	`lastMetricsPullAt` timestamp,
	`lastMetricsPullReason` varchar(120),
	`experimentId` int,
	`experimentGroup` enum('treatment','control'),
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(64) NOT NULL,
	`registeredAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `interventions_id` PRIMARY KEY(`id`),
	CONSTRAINT `intv_owner_key_uq` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `refreshPolicies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`regressionDropPercent` int NOT NULL DEFAULT 20,
	`minimumSampleSize` int NOT NULL DEFAULT 30,
	`staleAfterDays` int NOT NULL DEFAULT 90,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `refreshPolicies_id` PRIMARY KEY(`id`),
	CONSTRAINT `refresh_policy_owner_uq` UNIQUE(`ownerUserId`)
);
--> statement-breakpoint
CREATE TABLE `refreshQueue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`interventionId` int,
	`targetUrl` varchar(2048) NOT NULL,
	`urlHash` varchar(64) NOT NULL,
	`trigger` enum('manual','regression','expiry') NOT NULL,
	`severity` enum('info','warning','critical') NOT NULL,
	`reasonRule` varchar(120) NOT NULL,
	`reasonText` varchar(1000) NOT NULL,
	`reasonEvidence` json NOT NULL,
	`recommendedAction` varchar(500) NOT NULL,
	`status` enum('open','in_progress','done','dismissed') NOT NULL DEFAULT 'open',
	`dueAt` timestamp,
	`resolvedAt` timestamp,
	`dedupeKey` varchar(160) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `refreshQueue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `experimentResults` ADD CONSTRAINT `fk_exp_results_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `experimentResults` ADD CONSTRAINT `fk_exp_results_exp` FOREIGN KEY (`experimentId`) REFERENCES `interventionExperiments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `experimentResults` ADD CONSTRAINT `fk_exp_results_intv` FOREIGN KEY (`interventionId`) REFERENCES `interventions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventionEvents` ADD CONSTRAINT `fk_intv_events_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventionEvents` ADD CONSTRAINT `fk_intv_events_intv` FOREIGN KEY (`interventionId`) REFERENCES `interventions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventionExperiments` ADD CONSTRAINT `fk_intv_exp_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventionMeasurements` ADD CONSTRAINT `fk_intv_meas_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventionMeasurements` ADD CONSTRAINT `fk_intv_meas_intv` FOREIGN KEY (`interventionId`) REFERENCES `interventions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventions` ADD CONSTRAINT `fk_intv_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventions` ADD CONSTRAINT `fk_intv_brief` FOREIGN KEY (`briefId`) REFERENCES `seoGeoContentBriefs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventions` ADD CONSTRAINT `fk_intv_draft` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventions` ADD CONSTRAINT `fk_intv_entry` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interventions` ADD CONSTRAINT `fk_intv_exp` FOREIGN KEY (`experimentId`) REFERENCES `interventionExperiments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refreshPolicies` ADD CONSTRAINT `fk_refresh_policy_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refreshQueue` ADD CONSTRAINT `fk_refresh_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refreshQueue` ADD CONSTRAINT `fk_refresh_intv` FOREIGN KEY (`interventionId`) REFERENCES `interventions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `intv_events_owner_time_idx` ON `interventionEvents` (`ownerUserId`,`interventionId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `intv_owner_status_idx` ON `interventions` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `intv_owner_url_idx` ON `interventions` (`ownerUserId`,`urlHash`);--> statement-breakpoint
CREATE INDEX `intv_owner_entry_idx` ON `interventions` (`ownerUserId`,`entryId`);--> statement-breakpoint
CREATE INDEX `refresh_owner_status_idx` ON `refreshQueue` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `refresh_owner_dedupe_idx` ON `refreshQueue` (`ownerUserId`,`dedupeKey`);