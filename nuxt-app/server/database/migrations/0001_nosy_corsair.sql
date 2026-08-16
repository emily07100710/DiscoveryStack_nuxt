CREATE TABLE `auditEvidenceLedger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`auditRunId` int NOT NULL,
	`stage` enum('acquisition','normalisation','classification','human_review') NOT NULL,
	`claimKey` varchar(120) NOT NULL,
	`claimValue` text NOT NULL,
	`provenance` enum('observed','inferred','estimated','human_confirmed') NOT NULL,
	`observationIds` json NOT NULL,
	`confidence` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditEvidenceLedger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auditObservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`auditRunId` int NOT NULL,
	`auditPageId` int NOT NULL,
	`observationKey` varchar(120) NOT NULL,
	`valueText` text,
	`valueNumber` decimal(10,2),
	`evidenceQuote` text,
	`evidenceSelector` varchar(512),
	`confidence` int NOT NULL,
	`extractionVersion` varchar(80) NOT NULL,
	`observedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditObservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auditPages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`auditRunId` int NOT NULL,
	`sourceUrl` varchar(2048) NOT NULL,
	`finalUrl` varchar(2048),
	`canonicalUrl` varchar(2048),
	`pageType` enum('home','service','faq','contact','booking','work','other') NOT NULL DEFAULT 'other',
	`httpStatus` int,
	`title` varchar(500),
	`pageLanguage` varchar(24),
	`contentHash` varchar(128) NOT NULL,
	`snapshotStorageKey` varchar(512),
	`snapshotByteLength` int,
	`fetchedAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditPages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auditReviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`auditRunId` int NOT NULL,
	`reviewerUserId` int NOT NULL,
	`decision` enum('confirmed','amended','rejected') NOT NULL,
	`correctedPrimaryStage` enum('discovery','understanding','response','progression','conversion'),
	`reviewNote` text,
	`labelTaxonomyVersion` varchar(80) NOT NULL,
	`labelContractVersion` varchar(80) NOT NULL,
	`qualityCheckStatus` enum('pending','passed','needs_revision','rejected') NOT NULL DEFAULT 'pending',
	`qualityCheckNote` text,
	`approvedForTraining` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditReviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auditRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`provider` enum('manual','firecrawl') NOT NULL DEFAULT 'manual',
	`status` enum('queued','processing','completed','failed','cancelled','blocked') NOT NULL DEFAULT 'queued',
	`requestedUrl` varchar(2048) NOT NULL,
	`scopePolicy` json NOT NULL,
	`analyzerVersion` varchar(80) NOT NULL,
	`errorCode` varchar(80),
	`errorDetail` text,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	CONSTRAINT `auditRuns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auditTrainingExamples` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`auditRunId` int NOT NULL,
	`reviewId` int NOT NULL,
	`featureContractVersion` varchar(80) NOT NULL,
	`labelTaxonomyVersion` varchar(80) NOT NULL,
	`datasetVersion` varchar(80) NOT NULL,
	`splitVersion` varchar(80) NOT NULL,
	`dataSplit` enum('unassigned','train','validation','test','holdout') NOT NULL DEFAULT 'unassigned',
	`labelStage` enum('discovery','understanding','response','progression','conversion') NOT NULL,
	`labelDecision` enum('confirmed','amended') NOT NULL,
	`labelRationale` text NOT NULL,
	`featureVector` json NOT NULL,
	`trainingConsent` boolean NOT NULL,
	`consentRevokedAt` timestamp,
	`datasetStatus` enum('candidate','ready_for_evaluation','excluded','revoked') NOT NULL DEFAULT 'candidate',
	`qualityCheckStatus` enum('pending','passed','needs_revision','rejected') NOT NULL DEFAULT 'pending',
	`qualityCheckNote` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditTrainingExamples_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_training_examples_review_unique` UNIQUE(`reviewId`)
);
--> statement-breakpoint
CREATE TABLE `auditWorkspaces` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`displayName` varchar(160) NOT NULL,
	`targetDomain` varchar(253) NOT NULL,
	`language` enum('en','zh-hant') NOT NULL,
	`publicAuditAuthorization` boolean NOT NULL DEFAULT false,
	`trainingConsent` boolean NOT NULL DEFAULT false,
	`consentRevokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deletedAt` timestamp,
	CONSTRAINT `auditWorkspaces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `frictionAssessments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`auditRunId` int NOT NULL,
	`journeyStage` enum('discovery','understanding','response','progression','conversion') NOT NULL,
	`priorityRank` int NOT NULL,
	`score` decimal(6,2) NOT NULL,
	`assessmentStatus` enum('supported','insufficient_evidence','needs_review') NOT NULL,
	`summary` text NOT NULL,
	`evidenceLedgerIds` json NOT NULL,
	`classifierVersion` varchar(80) NOT NULL,
	`requiresHumanReview` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `frictionAssessments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `auditEvidenceLedger` ADD CONSTRAINT `auditEvidenceLedger_auditRunId_auditRuns_id_fk` FOREIGN KEY (`auditRunId`) REFERENCES `auditRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditObservations` ADD CONSTRAINT `auditObservations_auditRunId_auditRuns_id_fk` FOREIGN KEY (`auditRunId`) REFERENCES `auditRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditObservations` ADD CONSTRAINT `auditObservations_auditPageId_auditPages_id_fk` FOREIGN KEY (`auditPageId`) REFERENCES `auditPages`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditPages` ADD CONSTRAINT `auditPages_auditRunId_auditRuns_id_fk` FOREIGN KEY (`auditRunId`) REFERENCES `auditRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditReviews` ADD CONSTRAINT `auditReviews_auditRunId_auditRuns_id_fk` FOREIGN KEY (`auditRunId`) REFERENCES `auditRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditReviews` ADD CONSTRAINT `auditReviews_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditRuns` ADD CONSTRAINT `auditRuns_workspaceId_auditWorkspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `auditWorkspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditTrainingExamples` ADD CONSTRAINT `auditTrainingExamples_workspaceId_auditWorkspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `auditWorkspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditTrainingExamples` ADD CONSTRAINT `auditTrainingExamples_auditRunId_auditRuns_id_fk` FOREIGN KEY (`auditRunId`) REFERENCES `auditRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditTrainingExamples` ADD CONSTRAINT `auditTrainingExamples_reviewId_auditReviews_id_fk` FOREIGN KEY (`reviewId`) REFERENCES `auditReviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditWorkspaces` ADD CONSTRAINT `auditWorkspaces_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `frictionAssessments` ADD CONSTRAINT `frictionAssessments_auditRunId_auditRuns_id_fk` FOREIGN KEY (`auditRunId`) REFERENCES `auditRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_evidence_run_idx` ON `auditEvidenceLedger` (`auditRunId`);--> statement-breakpoint
CREATE INDEX `audit_observations_run_idx` ON `auditObservations` (`auditRunId`);--> statement-breakpoint
CREATE INDEX `audit_pages_run_idx` ON `auditPages` (`auditRunId`);--> statement-breakpoint
CREATE INDEX `audit_reviews_run_idx` ON `auditReviews` (`auditRunId`);--> statement-breakpoint
CREATE INDEX `audit_runs_workspace_idx` ON `auditRuns` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `audit_training_examples_workspace_idx` ON `auditTrainingExamples` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `audit_training_examples_dataset_idx` ON `auditTrainingExamples` (`datasetStatus`,`trainingConsent`);--> statement-breakpoint
CREATE INDEX `audit_workspaces_owner_idx` ON `auditWorkspaces` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `friction_assessments_run_idx` ON `frictionAssessments` (`auditRunId`);