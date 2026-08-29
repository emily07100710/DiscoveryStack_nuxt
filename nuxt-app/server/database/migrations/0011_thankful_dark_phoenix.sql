CREATE TABLE `seoGeoContentBriefs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`diagnosisId` int,
	`title` varchar(300) NOT NULL,
	`audience` varchar(300) NOT NULL,
	`contentType` enum('article','service_page','faq','landing_page','brief') NOT NULL,
	`language` enum('en','zh-hant') NOT NULL,
	`goals` json NOT NULL,
	`constraints` json NOT NULL,
	`evidenceRefs` json NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`status` enum('draft','ready_for_generation','approved','superseded','archived') NOT NULL DEFAULT 'draft',
	`reviewerUserId` int,
	`reviewNote` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seoGeoContentBriefs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoContentDrafts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`version` int NOT NULL,
	`title` varchar(500) NOT NULL,
	`body` text NOT NULL,
	`contentHash` varchar(128) NOT NULL,
	`sourceMode` enum('provider_candidate','reference_fallback','manual') NOT NULL,
	`provenance` json NOT NULL,
	`evidenceRefs` json NOT NULL,
	`safetyStatus` enum('passed','needs_review','blocked') NOT NULL,
	`safetyNotes` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `seoGeoContentDrafts_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_content_drafts_version_unique` UNIQUE(`jobId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoContentJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`briefId` int NOT NULL,
	`requestFingerprint` varchar(128) NOT NULL,
	`operation` enum('autogeo_recommendation','content_draft','risk_scan','delivery_preview','delivery_publish') NOT NULL,
	`providerMode` enum('reference_rules','autogeo_bailian_qwen','autogeo_api','manual') NOT NULL,
	`status` enum('queued','processing','candidate_ready','needs_human_review','approved','blocked','failed','delivered') NOT NULL DEFAULT 'queued',
	`idempotencyKey` varchar(128) NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`providerProvenance` json,
	`errorCode` varchar(120),
	`errorSummary` text,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	CONSTRAINT `seoGeoContentJobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_content_jobs_idempotency_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoContentReviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`draftId` int NOT NULL,
	`reviewerUserId` int NOT NULL,
	`decision` enum('approved_for_preview','approved_for_delivery','changes_requested','rejected') NOT NULL,
	`reviewNote` text,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `seoGeoContentReviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoContentRiskGates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`draftId` int NOT NULL,
	`gateVersion` varchar(80) NOT NULL,
	`status` enum('passed','needs_human_review','blocked') NOT NULL,
	`findings` json NOT NULL,
	`evidenceSnapshotHash` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `seoGeoContentRiskGates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoDeliveryAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`draftId` int NOT NULL,
	`targetId` int NOT NULL,
	`approvalReviewId` int,
	`idempotencyKey` varchar(128) NOT NULL,
	`mode` enum('preview','publish') NOT NULL,
	`status` enum('prepared','blocked','delivered','failed') NOT NULL,
	`deliverySummary` json NOT NULL,
	`externalReference` varchar(500),
	`errorCode` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `seoGeoDeliveryAttempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_delivery_attempt_idempotency_unique` UNIQUE(`targetId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoDeliveryTargets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`displayName` varchar(160) NOT NULL,
	`adapter` enum('manual_export','wordpress_rest','generic_http') NOT NULL,
	`targetOrigin` varchar(2048) NOT NULL,
	`status` enum('disabled','review_required','enabled') NOT NULL DEFAULT 'disabled',
	`allowPublish` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seoGeoDeliveryTargets_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_delivery_target_owner_origin_unique` UNIQUE(`ownerUserId`,`targetOrigin`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoDiagnoses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceId` int,
	`auditRunId` int,
	`inputFingerprint` varchar(128) NOT NULL,
	`diagnosisKind` enum('deterministic_baseline','approved_model') NOT NULL,
	`status` enum('completed','not_ready','needs_human_review','blocked','failed') NOT NULL,
	`modelReference` json,
	`evidenceRefs` json NOT NULL,
	`result` json NOT NULL,
	`limitations` json NOT NULL,
	`requiresHumanReview` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `seoGeoDiagnoses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `seoGeoEvidenceApprovals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceId` int NOT NULL,
	`artifactId` int,
	`allowedFor` enum('diagnosis','recommendation','content_draft') NOT NULL,
	`status` enum('approved','restricted','revoked') NOT NULL DEFAULT 'restricted',
	`policySnapshot` json NOT NULL,
	`reviewerUserId` int NOT NULL,
	`reviewNote` text,
	`approvedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `seoGeoEvidenceApprovals_id` PRIMARY KEY(`id`),
	CONSTRAINT `seo_geo_evidence_approval_unique` UNIQUE(`ownerUserId`,`sourceId`,`artifactId`,`allowedFor`)
);
--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD CONSTRAINT `seoGeoContentBriefs_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD CONSTRAINT `seoGeoContentBriefs_diagnosisId_seoGeoDiagnoses_id_fk` FOREIGN KEY (`diagnosisId`) REFERENCES `seoGeoDiagnoses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentBriefs` ADD CONSTRAINT `seoGeoContentBriefs_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentDrafts` ADD CONSTRAINT `seoGeoContentDrafts_jobId_seoGeoContentJobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `seoGeoContentJobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentJobs` ADD CONSTRAINT `seoGeoContentJobs_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentJobs` ADD CONSTRAINT `seoGeoContentJobs_briefId_seoGeoContentBriefs_id_fk` FOREIGN KEY (`briefId`) REFERENCES `seoGeoContentBriefs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentReviews` ADD CONSTRAINT `seoGeoContentReviews_jobId_seoGeoContentJobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `seoGeoContentJobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentReviews` ADD CONSTRAINT `seoGeoContentReviews_draftId_seoGeoContentDrafts_id_fk` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentReviews` ADD CONSTRAINT `seoGeoContentReviews_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoContentRiskGates` ADD CONSTRAINT `seoGeoContentRiskGates_draftId_seoGeoContentDrafts_id_fk` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoDeliveryAttempts` ADD CONSTRAINT `seoGeoDeliveryAttempts_jobId_seoGeoContentJobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `seoGeoContentJobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoDeliveryAttempts` ADD CONSTRAINT `seoGeoDeliveryAttempts_draftId_seoGeoContentDrafts_id_fk` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoDeliveryAttempts` ADD CONSTRAINT `seoGeoDeliveryAttempts_targetId_seoGeoDeliveryTargets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `seoGeoDeliveryTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoDeliveryAttempts` ADD CONSTRAINT `fk_seo_geo_delivery_attempt_approval_review_id_b332f1ba8e` FOREIGN KEY (`approvalReviewId`) REFERENCES `seoGeoContentReviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoDeliveryTargets` ADD CONSTRAINT `seoGeoDeliveryTargets_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoDiagnoses` ADD CONSTRAINT `seoGeoDiagnoses_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoDiagnoses` ADD CONSTRAINT `seoGeoDiagnoses_sourceId_publicIntelligenceSources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoDiagnoses` ADD CONSTRAINT `seoGeoDiagnoses_auditRunId_auditRuns_id_fk` FOREIGN KEY (`auditRunId`) REFERENCES `auditRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoEvidenceApprovals` ADD CONSTRAINT `seoGeoEvidenceApprovals_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoEvidenceApprovals` ADD CONSTRAINT `seoGeoEvidenceApprovals_sourceId_publicIntelligenceSources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoEvidenceApprovals` ADD CONSTRAINT `fk_seo_geo_evidence_approva_artifact_id_359e42c610` FOREIGN KEY (`artifactId`) REFERENCES `publicIntelligenceArtifacts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seoGeoEvidenceApprovals` ADD CONSTRAINT `seoGeoEvidenceApprovals_reviewerUserId_users_id_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `seo_geo_content_briefs_owner_idx` ON `seoGeoContentBriefs` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `seo_geo_content_briefs_diagnosis_idx` ON `seoGeoContentBriefs` (`diagnosisId`);--> statement-breakpoint
CREATE INDEX `seo_geo_content_drafts_job_idx` ON `seoGeoContentDrafts` (`jobId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `seo_geo_content_jobs_brief_idx` ON `seoGeoContentJobs` (`briefId`,`status`,`requestedAt`);--> statement-breakpoint
CREATE INDEX `seo_geo_content_reviews_job_idx` ON `seoGeoContentReviews` (`jobId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `seo_geo_content_risk_gates_draft_idx` ON `seoGeoContentRiskGates` (`draftId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `seo_geo_delivery_attempts_job_idx` ON `seoGeoDeliveryAttempts` (`jobId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `seo_geo_delivery_targets_owner_idx` ON `seoGeoDeliveryTargets` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `seo_geo_diagnoses_owner_idx` ON `seoGeoDiagnoses` (`ownerUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `seo_geo_diagnoses_source_idx` ON `seoGeoDiagnoses` (`sourceId`,`inputFingerprint`);--> statement-breakpoint
CREATE INDEX `seo_geo_evidence_approval_owner_idx` ON `seoGeoEvidenceApprovals` (`ownerUserId`,`status`,`allowedFor`);