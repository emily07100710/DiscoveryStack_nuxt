ALTER TABLE `publicIntelligenceTrainingRuns` MODIFY COLUMN `modelFamily` enum('huggingface_transformers') NOT NULL;--> statement-breakpoint
ALTER TABLE `publicIntelligenceTrainingRuns` ADD `provider` enum('huggingface_jobs') DEFAULT 'huggingface_jobs' NOT NULL;--> statement-breakpoint
ALTER TABLE `publicIntelligenceTrainingRuns` ADD `remoteJobId` varchar(160);--> statement-breakpoint
ALTER TABLE `publicIntelligenceTrainingRuns` ADD `remoteJobUrl` varchar(500);--> statement-breakpoint
ALTER TABLE `publicIntelligenceTrainingRuns` ADD `baseModelId` varchar(300);--> statement-breakpoint
ALTER TABLE `publicIntelligenceTrainingRuns` ADD `modelRepoId` varchar(300);--> statement-breakpoint
ALTER TABLE `publicIntelligenceTrainingRuns` ADD `datasetDigest` varchar(128);