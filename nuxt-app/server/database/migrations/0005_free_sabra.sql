CREATE TABLE `publicIntelligenceTrainingRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`datasetBuildId` int,
	`mode` enum('development','production') NOT NULL,
	`modelFamily` enum('prototype_centroid') NOT NULL,
	`modelVersion` varchar(120) NOT NULL,
	`featureContractVersion` varchar(80) NOT NULL,
	`labelTaxonomyVersion` varchar(80) NOT NULL,
	`splitVersion` varchar(80) NOT NULL,
	`status` enum('queued','running','completed','blocked','failed') NOT NULL DEFAULT 'queued',
	`exampleCount` int NOT NULL DEFAULT 0,
	`trainCount` int NOT NULL DEFAULT 0,
	`validationCount` int NOT NULL DEFAULT 0,
	`testCount` int NOT NULL DEFAULT 0,
	`labelCounts` json NOT NULL,
	`metrics` json,
	`modelArtifact` json,
	`errorCode` varchar(120),
	`errorDetail` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	CONSTRAINT `publicIntelligenceTrainingRuns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` MODIFY COLUMN `collectionMode` enum('owner_triggered_approved_fetch','owner_triggered_bounded_crawl') NOT NULL;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD `maxPages` int;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD `maxDepth` int;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD `pagesFetched` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD `pagesCleaned` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD `artifactsCreated` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD `crawlResults` json;--> statement-breakpoint
ALTER TABLE `publicIntelligenceTrainingRuns` ADD CONSTRAINT `publicIntelligenceTrainingRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceTrainingRuns` ADD CONSTRAINT `fk_public_intelligence_trai_dataset_build_id_43cf8ee54e` FOREIGN KEY (`datasetBuildId`) REFERENCES `publicIntelligenceDatasetBuilds`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `public_intelligence_training_owner_idx` ON `publicIntelligenceTrainingRuns` (`ownerUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `public_intelligence_training_status_idx` ON `publicIntelligenceTrainingRuns` (`status`,`mode`);