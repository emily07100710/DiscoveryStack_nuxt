CREATE TABLE `seoGeoProductionDeliverables` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`planId` int NOT NULL,
	`selectionId` int NOT NULL,
	`opportunityKey` varchar(180) NOT NULL,
	`contentType` enum('article','service_page','faq') NOT NULL,
	`title` varchar(300) NOT NULL,
	`audience` varchar(300) NOT NULL,
	`goals` json NOT NULL,
	`constraints` json NOT NULL,
	`language` enum('en','zh-hant') NOT NULL,
	`status` enum('planned','brief_ready','job_queued','candidate_ready','needs_human_review','approved','blocked','exported') NOT NULL DEFAULT 'planned',
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`briefId` int,
	`jobId` int,
	`idempotencyKey` varchar(128) NOT NULL,
	`provenance` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seoGeoProductionDeliverables_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_deliverable_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `seo_geo_deliverable_opportunity_unique` UNIQUE(`planId`,`opportunityKey`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoProductionPlanSelections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`planId` int NOT NULL,
	`strategyRecommendationId` int NOT NULL,
	`status` enum('selected','deselected') NOT NULL DEFAULT 'selected',
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`provenance` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seoGeoProductionPlanSelections_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_plan_selection_unique` UNIQUE(`ownerUserId`,`planId`,`strategyRecommendationId`),
	CONSTRAINT `seo_geo_plan_selection_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoProductionPlans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`diagnosisId` int,
	`title` varchar(300) NOT NULL,
	`language` enum('en','zh-hant') NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`status` enum('draft','ready','generating','in_progress','completed','blocked','archived') NOT NULL DEFAULT 'draft',
	`idempotencyKey` varchar(128) NOT NULL,
	`provenance` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seoGeoProductionPlans_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_plan_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoStrategyRecommendations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`diagnosisId` int NOT NULL,
	`issueCode` varchar(160) NOT NULL,
	`recommendationKey` varchar(160) NOT NULL,
	`ruleSetVersion` varchar(80) NOT NULL,
	`ruleIds` json NOT NULL,
	`rules` json NOT NULL,
	`priority` enum('high','medium','low') NOT NULL,
	`rationale` text NOT NULL,
	`recommendedActions` json NOT NULL,
	`deliverableTypes` json NOT NULL,
	`contentOpportunities` json NOT NULL,
	`evidenceRefs` json NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`status` enum('proposed','selected','rejected','superseded') NOT NULL DEFAULT 'proposed',
	`limitations` json NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`idempotencyKey` varchar(128) NOT NULL,
	`provenance` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seoGeoStrategyRecommendations_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_strategy_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `seo_geo_strategy_version_unique` UNIQUE(`ownerUserId`,`diagnosisId`,`issueCode`,`version`)
);
--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD `strategyRecommendationId` int;--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD `productionPlanId` int;--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD `productionDeliverableId` int;--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD `ruleIds` json;--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD `provenance` json;--> statement-breakpoint
ALTER TABLE `seoGeoContentJobs` ADD `productionPlanId` int;--> statement-breakpoint
ALTER TABLE `seoGeoContentJobs` ADD `strategyRecommendationId` int;--> statement-breakpoint
ALTER TABLE `seoGeoContentJobs` ADD `productionDeliverableId` int;--> statement-breakpoint
ALTER TABLE `seoGeoProductionDeliverables` ADD CONSTRAINT `seoGeoProductionDeliverables_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoProductionDeliverables` ADD CONSTRAINT `seoGeoProductionDeliverables_planId_seoGeoProductionPlans_id_fk` FOREIGN KEY (`planId`) REFERENCES `seoGeoProductionPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoProductionDeliverables` ADD CONSTRAINT `seoGeoProductionDeliverables_selectionId_seoGeoProductionPlanSelections_id_fk` FOREIGN KEY (`selectionId`) REFERENCES `seoGeoProductionPlanSelections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoProductionDeliverables` ADD CONSTRAINT `seoGeoProductionDeliverables_briefId_seoGeoContentBriefs_id_fk` FOREIGN KEY (`briefId`) REFERENCES `seoGeoContentBriefs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoProductionPlanSelections` ADD CONSTRAINT `seoGeoProductionPlanSelections_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoProductionPlanSelections` ADD CONSTRAINT `seoGeoProductionPlanSelections_planId_seoGeoProductionPlans_id_fk` FOREIGN KEY (`planId`) REFERENCES `seoGeoProductionPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoProductionPlanSelections` ADD CONSTRAINT `seoGeoProductionPlanSelections_strategyRecommendationId_seoGeoStrategyRecommendations_id_fk` FOREIGN KEY (`strategyRecommendationId`) REFERENCES `seoGeoStrategyRecommendations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoProductionPlans` ADD CONSTRAINT `seoGeoProductionPlans_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoProductionPlans` ADD CONSTRAINT `seoGeoProductionPlans_diagnosisId_seoGeoDiagnoses_id_fk` FOREIGN KEY (`diagnosisId`) REFERENCES `seoGeoDiagnoses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoStrategyRecommendations` ADD CONSTRAINT `seoGeoStrategyRecommendations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoStrategyRecommendations` ADD CONSTRAINT `seoGeoStrategyRecommendations_diagnosisId_seoGeoDiagnoses_id_fk` FOREIGN KEY (`diagnosisId`) REFERENCES `seoGeoDiagnoses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `seo_geo_deliverable_plan_idx` ON `seoGeoProductionDeliverables` (`planId`,`status`);--> statement-breakpoint
CREATE INDEX `seo_geo_plan_selection_plan_idx` ON `seoGeoProductionPlanSelections` (`planId`,`status`);--> statement-breakpoint
CREATE INDEX `seo_geo_plan_owner_idx` ON `seoGeoProductionPlans` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `seo_geo_strategy_owner_idx` ON `seoGeoStrategyRecommendations` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD CONSTRAINT `seoGeoContentBriefs_strategyRecommendationId_seoGeoStrategyRecommendations_id_fk` FOREIGN KEY (`strategyRecommendationId`) REFERENCES `seoGeoStrategyRecommendations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD CONSTRAINT `seoGeoContentBriefs_productionPlanId_seoGeoProductionPlans_id_fk` FOREIGN KEY (`productionPlanId`) REFERENCES `seoGeoProductionPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentJobs` ADD CONSTRAINT `seoGeoContentJobs_productionPlanId_seoGeoProductionPlans_id_fk` FOREIGN KEY (`productionPlanId`) REFERENCES `seoGeoProductionPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentJobs` ADD CONSTRAINT `seoGeoContentJobs_strategyRecommendationId_seoGeoStrategyRecommendations_id_fk` FOREIGN KEY (`strategyRecommendationId`) REFERENCES `seoGeoStrategyRecommendations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentJobs` ADD CONSTRAINT `seoGeoContentJobs_productionDeliverableId_seoGeoProductionDeliverables_id_fk` FOREIGN KEY (`productionDeliverableId`) REFERENCES `seoGeoProductionDeliverables`(`id`) ON DELETE no action ON UPDATE no action;