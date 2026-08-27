CREATE TABLE `geoOutcomeEvidenceLocators` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`observationFingerprint` varchar(128) NOT NULL,
	`evidenceLocatorHash` varchar(128) NOT NULL,
	`purpose` enum('geo_outcome_verification') NOT NULL,
	`artifactHash` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `geoOutcomeEvidenceLocators_id` PRIMARY KEY(`id`),
	CONSTRAINT `geo_outcome_evidence_locator_unique` UNIQUE(`ownerUserId`,`evidenceLocatorHash`)
);
--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` MODIFY COLUMN `evidenceLocatorHash` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeDatasetManifests` ADD `readiness` json NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` ADD `factType` enum('evidence_verification','consent_review','pii_review','revocation') NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeObservationVerifications` ADD `factStatus` enum('approved','rejected','revoked') NOT NULL;--> statement-breakpoint
ALTER TABLE `geoOutcomeEvidenceLocators` ADD CONSTRAINT `geoOutcomeEvidenceLocators_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `geo_outcome_evidence_observation_idx` ON `geoOutcomeEvidenceLocators` (`ownerUserId`,`observationFingerprint`);