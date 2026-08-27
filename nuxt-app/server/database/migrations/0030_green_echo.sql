CREATE TABLE `geoOutcomeIdempotencyClaims` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`routeIdentity` varchar(160) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`inputFingerprint` varchar(128) NOT NULL,
	`state` enum('claimed','completed','failed') NOT NULL DEFAULT 'claimed',
	`responseProjection` json,
	`responseFingerprint` varchar(128),
	`leaseOwner` varchar(128),
	`leaseExpiresAt` timestamp,
	`version` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `geoOutcomeIdempotencyClaims_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_idempotency_owner_route_key_unique` UNIQUE(`ownerUserId`,`routeIdentity`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `geoOutcomeObservationVerifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`observationFingerprint` varchar(128) NOT NULL,
	`reviewerUserId` int NOT NULL,
	`previousVerificationStatus` varchar(48) NOT NULL,
	`newVerificationStatus` varchar(48) NOT NULL,
	`evidenceLocatorHash` varchar(128) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`decisionFingerprint` varchar(128) NOT NULL,
	`consentStatus` enum('approved','revoked','unknown') NOT NULL,
	`piiStatus` enum('clean','contains_pii','unknown') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeObservationVerifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_verification_decision_unique` UNIQUE(`ownerUserId`,`decisionFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetMembers` ADD `splitAssignment` enum('train','validation','test','site_holdout','query_holdout','temporal_holdout') NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetMembers` ADD `consentStatus` enum('approved','revoked','unknown') DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetMembers` ADD `piiStatus` enum('clean','contains_pii','unknown') DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetMembers` ADD `reviewFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeModelArtifacts` ADD `rollbackArtifactHash` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD `consentStatus` enum('approved','revoked','unknown') DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD `piiStatus` enum('clean','contains_pii','unknown') DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD `verificationAuthority` varchar(96) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD `intakeFingerprint` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD `reviewFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationCandidates` ADD `observationPayload` json NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD `startedAt` timestamp;--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD `completedAt` timestamp;--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD `leaseOwner` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD `leaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `geoOutcomeTrainingRuns` ADD `version` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeIdempotencyClaims` ADD CONSTRAINT `geoOutcomeIdempotencyClaims_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` ADD CONSTRAINT `geoOutcomeObservationVerifications_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` ADD CONSTRAINT `geoOutcomeObservationVerifications_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `geo_outcome_idempotency_lease_idx` ON `geoOutcomeIdempotencyClaims` (`state`,`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `geo_outcome_verification_observation_idx` ON `geoOutcomeObservationVerifications` (`ownerUserId`,`observationFingerprint`,`createdAt`);