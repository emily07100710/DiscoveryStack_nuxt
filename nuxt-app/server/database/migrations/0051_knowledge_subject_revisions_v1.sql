CREATE TABLE `knowledgeMutationEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`subjectKind` enum('entity','claim','source') NOT NULL,
	`subjectId` int NOT NULL,
	`revisionId` int NOT NULL,
	`revisionNumber` int NOT NULL,
	`previousRevisionFingerprint` varchar(64),
	`newRevisionFingerprint` varchar(64) NOT NULL,
	`eventFingerprint` varchar(64) NOT NULL,
	`operations` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledgeMutationEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `kme_owner_event_uq` UNIQUE(`ownerUserId`,`eventFingerprint`),
	CONSTRAINT `kme_revision_uq` UNIQUE(`revisionId`),
	CONSTRAINT `kme_owner_revision_fp_uq` UNIQUE(`ownerUserId`,`newRevisionFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeSubjectRevisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`subjectKind` enum('entity','claim','source') NOT NULL,
	`subjectId` int NOT NULL,
	`schemaVersion` varchar(64) NOT NULL,
	`revisionNumber` int NOT NULL,
	`revisionKind` enum('legacy_baseline','mutation') NOT NULL,
	`canonicalSnapshot` longtext NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`previousRevisionFingerprint` varchar(64),
	`revisionFingerprint` varchar(64) NOT NULL,
	`operations` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledgeSubjectRevisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `ksr_subject_version_uq` UNIQUE(`ownerUserId`,`subjectKind`,`subjectId`,`revisionNumber`),
	CONSTRAINT `ksr_owner_fingerprint_uq` UNIQUE(`ownerUserId`,`revisionFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `knowledgeMutationEvents` ADD CONSTRAINT `kme_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeMutationEvents` ADD CONSTRAINT `kme_revision_fk` FOREIGN KEY (`revisionId`) REFERENCES `knowledgeSubjectRevisions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeSubjectRevisions` ADD CONSTRAINT `ksr_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `kme_subject_history_idx` ON `knowledgeMutationEvents` (`ownerUserId`,`subjectKind`,`subjectId`,`id`);--> statement-breakpoint
CREATE INDEX `ksr_subject_history_idx` ON `knowledgeSubjectRevisions` (`ownerUserId`,`subjectKind`,`subjectId`,`id`);