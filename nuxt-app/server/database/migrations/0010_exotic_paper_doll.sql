CREATE TABLE `modelImprovementCandidates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`leadId` int NOT NULL,
	`collectionRunId` int NOT NULL,
	`sourceUrl` varchar(2048) NOT NULL,
	`finalUrl` varchar(2048),
	`hostname` varchar(253) NOT NULL,
	`consentVersion` varchar(80) NOT NULL,
	`consentedAt` timestamp NOT NULL,
	`consentRevokedAt` timestamp,
	`status` enum('collection_failed','ready_for_review','approved','rejected','revoked') NOT NULL DEFAULT 'ready_for_review',
	`robotsStatus` enum('allowed','disallowed','unavailable','error') NOT NULL,
	`robotsCheckedAt` timestamp NOT NULL,
	`snapshotFingerprint` varchar(64),
	`analysisVersion` varchar(80) NOT NULL,
	`featureData` json NOT NULL,
	`suggestedLabelData` json NOT NULL,
	`approvedLabelData` json,
	`collectionErrorCode` varchar(120),
	`reviewerUserId` int,
	`reviewNote` text,
	`publicSourceId` int,
	`publicArtifactId` int,
	`collectedAt` timestamp,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `modelImprovementCandidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_improvement_candidate_lead_unique` UNIQUE(`ownerUserId`,`leadId`)
);
--> statement-breakpoint
CREATE TABLE `modelImprovementCollectionRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`trigger` enum('scheduled','owner_manual') NOT NULL,
	`status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`leadsExamined` int NOT NULL DEFAULT 0,
	`eligibleLeads` int NOT NULL DEFAULT 0,
	`collectedCandidates` int NOT NULL DEFAULT 0,
	`duplicateCandidates` int NOT NULL DEFAULT 0,
	`skippedCandidates` int NOT NULL DEFAULT 0,
	`revokedCandidates` int NOT NULL DEFAULT 0,
	`failedCandidates` int NOT NULL DEFAULT 0,
	`errorSummary` json NOT NULL,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `modelImprovementCollectionRuns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `publicIntelligenceSources` MODIFY COLUMN `discoveryMethod` enum('owner_research','public_search','api_catalogue','licensed_import','customer_consent') NOT NULL;--> statement-breakpoint
ALTER TABLE `modelImprovementCandidates` ADD CONSTRAINT `modelImprovementCandidates_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `modelImprovementCandidates` ADD CONSTRAINT `modelImprovementCandidates_leadId_leads_id_fk` FOREIGN KEY (`leadId`) REFERENCES `leads`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `modelImprovementCandidates` ADD CONSTRAINT `fk_model_improvement_candid_collection_run_id_04a0139065` FOREIGN KEY (`collectionRunId`) REFERENCES `modelImprovementCollectionRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `modelImprovementCandidates` ADD CONSTRAINT `modelImprovementCandidates_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `modelImprovementCandidates` ADD CONSTRAINT `fk_model_improvement_candid_public_source_id_05804cf05a` FOREIGN KEY (`publicSourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `modelImprovementCandidates` ADD CONSTRAINT `fk_model_improvement_candid_public_artifact_id_15d483e187` FOREIGN KEY (`publicArtifactId`) REFERENCES `publicIntelligenceArtifacts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `modelImprovementCollectionRuns` ADD CONSTRAINT `modelImprovementCollectionRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `model_improvement_candidate_status_idx` ON `modelImprovementCandidates` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `model_improvement_candidate_snapshot_idx` ON `modelImprovementCandidates` (`snapshotFingerprint`);--> statement-breakpoint
CREATE INDEX `model_improvement_collection_owner_idx` ON `modelImprovementCollectionRuns` (`ownerUserId`,`startedAt`);--> statement-breakpoint
CREATE INDEX `model_improvement_collection_status_idx` ON `modelImprovementCollectionRuns` (`status`,`startedAt`);