CREATE TABLE `geoOutcomeModelopsCycles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cycleId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`policyId` varchar(160) NOT NULL,
	`policyFingerprint` varchar(128) NOT NULL,
	`trigger` enum('scheduled','owner_manual','dry_run') NOT NULL,
	`status` enum('planned','running','completed','blocked','insufficient_data','failed','retry_wait') NOT NULL DEFAULT 'planned',
	`readinessSnapshotFingerprint` varchar(128) NOT NULL,
	`eligibleObservationFingerprints` json NOT NULL,
	`previousApprovedDatasetFingerprint` varchar(128),
	`generatedDatasetFingerprint` varchar(128),
	`trainingRunId` varchar(160),
	`modelArtifactId` varchar(160),
	`artifactHash` varchar(128),
	`shadowEvaluationFingerprint` varchar(128),
	`reasonCodes` json NOT NULL,
	`limitations` json NOT NULL,
	`errorClass` varchar(120),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`attempt` int NOT NULL DEFAULT 0,
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `geoOutcomeModelopsCycles_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_modelops_cycle_owner_id_unique` UNIQUE(`ownerUserId`,`cycleId`),
	CONSTRAINT `geo_outcome_modelops_cycle_owner_key_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeModelopsEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`cycleId` varchar(160) NOT NULL,
	`eventType` varchar(96) NOT NULL,
	`eventPayload` json NOT NULL,
	`eventFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeModelopsEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_modelops_event_id_unique` UNIQUE(`eventId`),
	CONSTRAINT `geo_outcome_modelops_event_fingerprint_unique` UNIQUE(`ownerUserId`,`eventFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeModelopsPolicies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`policyId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`status` enum('enabled','paused','revoked') NOT NULL DEFAULT 'paused',
	`cadence` enum('weekly','biweekly','monthly') NOT NULL,
	`minimumNewVerifiedCandidates` int NOT NULL,
	`minimumNewQueryGroups` int NOT NULL,
	`minimumNewWebsites` int NOT NULL,
	`minimumObservationSpanDays` int NOT NULL,
	`allowedModelFamilies` json NOT NULL,
	`maximumTrainingRunsPerCycle` int NOT NULL,
	`cooldownHours` int NOT NULL,
	`shadowEvaluationEnabled` boolean NOT NULL DEFAULT true,
	`authorizedByOwnerUserId` int,
	`authorizedAt` timestamp,
	`expiresAt` timestamp,
	`configurationFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`revokedAt` timestamp,
	CONSTRAINT `geoOutcomeModelopsPolicies_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_modelops_policy_owner_id_unique` UNIQUE(`ownerUserId`,`policyId`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeModelopsRollbackDecisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`decisionId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`artifactId` varchar(160) NOT NULL,
	`fromArtifactHash` varchar(128) NOT NULL,
	`rollbackArtifactHash` varchar(128) NOT NULL,
	`reviewerUserId` int NOT NULL,
	`reason` varchar(500) NOT NULL,
	`decisionStatus` enum('approved','rejected') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeModelopsRollbackDecisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_modelops_rollback_decision_unique` UNIQUE(`decisionId`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeModelopsShadowEvaluations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`evaluationId` varchar(160) NOT NULL,
	`ownerUserId` int NOT NULL,
	`artifactId` varchar(160) NOT NULL,
	`artifactHash` varchar(128) NOT NULL,
	`evaluationWindowStart` timestamp NOT NULL,
	`evaluationWindowEnd` timestamp NOT NULL,
	`observationFingerprints` json NOT NULL,
	`candidateCount` int NOT NULL,
	`positiveCount` int NOT NULL,
	`negativeCount` int NOT NULL,
	`queryGroupCount` int NOT NULL,
	`websiteCount` int NOT NULL,
	`engineCounts` json NOT NULL,
	`binaryMetrics` json NOT NULL,
	`rankingMetrics` json NOT NULL,
	`calibrationDiagnostics` json NOT NULL,
	`driftDiagnostics` json NOT NULL,
	`status` enum('completed','insufficient_data','blocked','needs_owner_attention') NOT NULL,
	`reasonCodes` json NOT NULL,
	`evaluationFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeModelopsShadowEvaluations_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_modelops_shadow_evaluation_id_unique` UNIQUE(`ownerUserId`,`evaluationId`),
	CONSTRAINT `geo_outcome_modelops_shadow_evaluation_fingerprint_unique` UNIQUE(`ownerUserId`,`evaluationFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsCycles` ADD CONSTRAINT `geoOutcomeModelopsCycles_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsEvents` ADD CONSTRAINT `geoOutcomeModelopsEvents_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsPolicies` ADD CONSTRAINT `geoOutcomeModelopsPolicies_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsPolicies` ADD CONSTRAINT `geoOutcomeModelopsPolicies_authorizedByOwnerUserId_users_id_fk` FOREIGN KEY (`authorizedByOwnerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsRollbackDecisions` ADD CONSTRAINT `geoOutcomeModelopsRollbackDecisions_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsRollbackDecisions` ADD CONSTRAINT `geoOutcomeModelopsRollbackDecisions_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsShadowEvaluations` ADD CONSTRAINT `geoOutcomeModelopsShadowEvaluations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `geo_outcome_modelops_cycle_owner_status_idx` ON `geoOutcomeModelopsCycles` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_modelops_cycle_lease_idx` ON `geoOutcomeModelopsCycles` (`status`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_modelops_event_cycle_idx` ON `geoOutcomeModelopsEvents` (`ownerUserId`,`cycleId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_modelops_policy_owner_status_idx` ON `geoOutcomeModelopsPolicies` (`ownerUserId`,`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_modelops_rollback_owner_artifact_idx` ON `geoOutcomeModelopsRollbackDecisions` (`ownerUserId`,`artifactId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_modelops_shadow_artifact_idx` ON `geoOutcomeModelopsShadowEvaluations` (`ownerUserId`,`artifactId`,`createdAt`);