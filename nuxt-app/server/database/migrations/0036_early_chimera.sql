CREATE TABLE `llmVisibilityBenchmarkRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`label` varchar(160),
	`brandName` varchar(160) NOT NULL,
	`brandAliases` json NOT NULL,
	`measuredDomain` varchar(253) NOT NULL,
	`status` enum('queued','running','completed','partial','failed') NOT NULL DEFAULT 'queued',
	`sampleSize` int NOT NULL,
	`requestedSamples` int NOT NULL,
	`succeededSamples` int NOT NULL DEFAULT 0,
	`failedSamples` int NOT NULL DEFAULT 0,
	`queryIds` json NOT NULL,
	`providerTargets` json NOT NULL,
	`promptVersionIds` json NOT NULL,
	`competitorSnapshot` json NOT NULL,
	`engineVersion` varchar(80) NOT NULL,
	`maximumProbes` int NOT NULL,
	`concurrency` int NOT NULL,
	`limitationCodes` json NOT NULL DEFAULT ('[]'),
	`aggregateSnapshot` json,
	`aggregateComputedAt` datetime,
	`startedAt` datetime,
	`lastProgressAt` datetime,
	`completedAt` datetime,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `llmVisibilityBenchmarkRuns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `llmVisibilityBenchmarkSamples` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`benchmarkRunId` int NOT NULL,
	`projectId` int NOT NULL,
	`queryId` int NOT NULL,
	`promptVersionId` int NOT NULL,
	`sampleIndex` int NOT NULL,
	`provider` enum('chatgpt','gemini','perplexity') NOT NULL,
	`modelLabel` varchar(160) NOT NULL,
	`adapterKey` varchar(120) NOT NULL,
	`locale` enum('en','zh-hant') NOT NULL,
	`observationWindowKey` varchar(160) NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`status` enum('pending','running','succeeded','failed') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`failureKind` varchar(60),
	`failureCode` varchar(120),
	`runId` int,
	`observationId` int,
	`startedAt` datetime,
	`completedAt` datetime,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `llmVisibilityBenchmarkSamples_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_vis_bench_samples_identity_unique` UNIQUE(`benchmarkRunId`,`queryId`,`provider`,`modelLabel`,`sampleIndex`),
	CONSTRAINT `llm_vis_bench_samples_fingerprint_unique` UNIQUE(`ownerUserId`,`requestFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `llmVisibilityCompetitors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`canonicalKey` varchar(160) NOT NULL,
	`aliases` json NOT NULL DEFAULT ('[]'),
	`domain` varchar(253),
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `llmVisibilityCompetitors_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_vis_competitors_project_key_unique` UNIQUE(`projectId`,`canonicalKey`)
);
--> statement-breakpoint
CREATE TABLE `llmVisibilityPromptVersions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`queryId` int NOT NULL,
	`versionNumber` int NOT NULL,
	`promptText` text NOT NULL,
	`promptHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `llmVisibilityPromptVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_vis_prompt_versions_query_version_unique` UNIQUE(`queryId`,`versionNumber`)
);
--> statement-breakpoint
ALTER TABLE `llmVisibilityObservations` ADD `promptVersionId` int;--> statement-breakpoint
ALTER TABLE `llmVisibilityObservations` ADD `citationFreshness` json;--> statement-breakpoint
ALTER TABLE `llmVisibilityRuns` ADD `promptVersionId` int;--> statement-breakpoint
ALTER TABLE `llmVisibilityRuns` ADD `benchmarkRunId` int;--> statement-breakpoint
ALTER TABLE `llmVisibilityRuns` ADD `sampleIndex` int;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkRuns` ADD CONSTRAINT `fk_llm_vis_benchmark_runs_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkRuns` ADD CONSTRAINT `fk_llm_vis_benchmark_runs_project` FOREIGN KEY (`projectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkSamples` ADD CONSTRAINT `fk_llm_vis_bench_samples_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkSamples` ADD CONSTRAINT `fk_llm_vis_bench_samples_benchmark` FOREIGN KEY (`benchmarkRunId`) REFERENCES `llmVisibilityBenchmarkRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkSamples` ADD CONSTRAINT `fk_llm_vis_bench_samples_project` FOREIGN KEY (`projectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkSamples` ADD CONSTRAINT `fk_llm_vis_bench_samples_query` FOREIGN KEY (`queryId`) REFERENCES `llmVisibilityQueries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkSamples` ADD CONSTRAINT `fk_llm_vis_bench_samples_prompt_version` FOREIGN KEY (`promptVersionId`) REFERENCES `llmVisibilityPromptVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkSamples` ADD CONSTRAINT `fk_llm_vis_bench_samples_run` FOREIGN KEY (`runId`) REFERENCES `llmVisibilityRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityBenchmarkSamples` ADD CONSTRAINT `fk_llm_vis_bench_samples_observation` FOREIGN KEY (`observationId`) REFERENCES `llmVisibilityObservations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityCompetitors` ADD CONSTRAINT `fk_llm_vis_competitors_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityCompetitors` ADD CONSTRAINT `fk_llm_vis_competitors_project` FOREIGN KEY (`projectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityPromptVersions` ADD CONSTRAINT `fk_llm_vis_prompt_versions_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityPromptVersions` ADD CONSTRAINT `fk_llm_vis_prompt_versions_project` FOREIGN KEY (`projectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityPromptVersions` ADD CONSTRAINT `fk_llm_vis_prompt_versions_query` FOREIGN KEY (`queryId`) REFERENCES `llmVisibilityQueries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `llm_vis_benchmark_runs_owner_project_created_idx` ON `llmVisibilityBenchmarkRuns` (`ownerUserId`,`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `llm_vis_benchmark_runs_owner_status_idx` ON `llmVisibilityBenchmarkRuns` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `llm_vis_bench_samples_run_status_idx` ON `llmVisibilityBenchmarkSamples` (`benchmarkRunId`,`status`);--> statement-breakpoint
CREATE INDEX `llm_vis_competitors_owner_project_active_idx` ON `llmVisibilityCompetitors` (`ownerUserId`,`projectId`,`active`);--> statement-breakpoint
CREATE INDEX `llm_vis_prompt_versions_owner_project_idx` ON `llmVisibilityPromptVersions` (`ownerUserId`,`projectId`);--> statement-breakpoint
ALTER TABLE `llmVisibilityObservations` ADD CONSTRAINT `fk_llm_vis_observations_prompt_version` FOREIGN KEY (`promptVersionId`) REFERENCES `llmVisibilityPromptVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityRuns` ADD CONSTRAINT `fk_llm_vis_runs_prompt_version` FOREIGN KEY (`promptVersionId`) REFERENCES `llmVisibilityPromptVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `llm_vis_runs_benchmark_idx` ON `llmVisibilityRuns` (`benchmarkRunId`);