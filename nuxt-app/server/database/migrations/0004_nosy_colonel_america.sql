CREATE TABLE `publicIntelligenceInferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceId` int NOT NULL,
	`ingestionJobId` int,
	`artifactIds` json NOT NULL,
	`analysisKind` enum('journey_friction_baseline','bge_m3_similarity') NOT NULL,
	`modelFamily` enum('rule_baseline','bge_m3') NOT NULL,
	`modelVersion` varchar(120) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`output` json NOT NULL,
	`status` enum('completed','needs_human_review','blocked','failed') NOT NULL,
	`requiresHumanReview` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `publicIntelligenceInferences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `publicIntelligenceIngestionJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceId` int NOT NULL,
	`requestedUrl` varchar(2048) NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`collectionMode` enum('owner_triggered_approved_fetch') NOT NULL,
	`status` enum('queued','processing','completed','duplicate','needs_human_review','policy_blocked','failed') NOT NULL DEFAULT 'queued',
	`policySnapshot` json NOT NULL,
	`finalUrl` varchar(2048),
	`httpStatus` int,
	`contentHash` varchar(128),
	`cleanedTextHash` varchar(128),
	`responseByteLength` int,
	`cleanedCharacterCount` int,
	`piiOutcome` enum('not_detected','redacted','needs_human_review','blocked') NOT NULL DEFAULT 'not_detected',
	`piiFindingCounts` json NOT NULL,
	`extractorVersion` varchar(80) NOT NULL,
	`primaryArtifactId` int,
	`errorCode` varchar(80),
	`errorDetail` text,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	CONSTRAINT `publicIntelligenceIngestionJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `publicIntelligenceInferences` ADD CONSTRAINT `piii_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceInferences` ADD CONSTRAINT `piii_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceInferences` ADD CONSTRAINT `piii_job_fk` FOREIGN KEY (`ingestionJobId`) REFERENCES `publicIntelligenceIngestionJobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD CONSTRAINT `piij_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD CONSTRAINT `piij_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceIngestionJobs` ADD CONSTRAINT `piij_artifact_fk` FOREIGN KEY (`primaryArtifactId`) REFERENCES `publicIntelligenceArtifacts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `public_intelligence_inference_owner_idx` ON `publicIntelligenceInferences` (`ownerUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `public_intelligence_inference_job_idx` ON `publicIntelligenceInferences` (`ingestionJobId`);--> statement-breakpoint
CREATE INDEX `public_intelligence_ingestion_owner_idx` ON `publicIntelligenceIngestionJobs` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `public_intelligence_ingestion_source_hash_idx` ON `publicIntelligenceIngestionJobs` (`sourceId`,`contentHash`);
