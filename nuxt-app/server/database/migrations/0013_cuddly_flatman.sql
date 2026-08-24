CREATE TABLE `llmVisibilityObservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`runId` int NOT NULL,
	`queryId` int NOT NULL,
	`brandMentioned` boolean NOT NULL,
	`exactMentionCount` int NOT NULL,
	`firstMentionPosition` int,
	`citedDomain` varchar(253),
	`citationUrls` json NOT NULL,
	`competitorMentions` json NOT NULL,
	`boundedExcerpt` text NOT NULL,
	`responseHash` varchar(64) NOT NULL,
	`evidenceLocator` varchar(1000) NOT NULL,
	`reviewerNote` text NOT NULL,
	`verifiedByOwner` boolean NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `llmVisibilityObservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_visibility_observations_run_query_unique` UNIQUE(`runId`,`queryId`)
);
--> statement-breakpoint
CREATE TABLE `llmVisibilityProjects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`canonicalWebsiteUrl` varchar(2048) NOT NULL,
	`canonicalDomain` varchar(253) NOT NULL,
	`locale` enum('en','zh-hant') NOT NULL,
	`brandName` varchar(160) NOT NULL,
	`brandAliases` json NOT NULL,
	`competitorBrands` json NOT NULL,
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `llmVisibilityProjects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `llmVisibilityQueries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`promptText` text NOT NULL,
	`promptHash` varchar(64) NOT NULL,
	`intent` varchar(120) NOT NULL,
	`locale` enum('en','zh-hant') NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `llmVisibilityQueries_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_visibility_queries_project_prompt_unique` UNIQUE(`projectId`,`promptHash`)
);
--> statement-breakpoint
CREATE TABLE `llmVisibilityRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`projectId` int NOT NULL,
	`provider` enum('chatgpt','gemini','perplexity','google_ai_overview','manual_other') NOT NULL,
	`modelLabel` varchar(160) NOT NULL,
	`observationMode` enum('manual_verified','provider_api_observation') NOT NULL,
	`status` enum('queued','completed','blocked','failed') NOT NULL,
	`observedAt` timestamp NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`limitationCode` varchar(120) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `llmVisibilityRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_visibility_runs_owner_fingerprint_unique` UNIQUE(`ownerUserId`,`requestFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `llmVisibilityObservations` ADD CONSTRAINT `llmVisibilityObservations_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityObservations` ADD CONSTRAINT `llmVisibilityObservations_projectId_llmVisibilityProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityObservations` ADD CONSTRAINT `llmVisibilityObservations_runId_llmVisibilityRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `llmVisibilityRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityObservations` ADD CONSTRAINT `llmVisibilityObservations_queryId_llmVisibilityQueries_id_fk` FOREIGN KEY (`queryId`) REFERENCES `llmVisibilityQueries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityProjects` ADD CONSTRAINT `llmVisibilityProjects_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityQueries` ADD CONSTRAINT `llmVisibilityQueries_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityQueries` ADD CONSTRAINT `llmVisibilityQueries_projectId_llmVisibilityProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityRuns` ADD CONSTRAINT `llmVisibilityRuns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `llmVisibilityRuns` ADD CONSTRAINT `llmVisibilityRuns_projectId_llmVisibilityProjects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `llmVisibilityProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `llm_visibility_observations_owner_idx` ON `llmVisibilityObservations` (`ownerUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `llm_visibility_observations_project_idx` ON `llmVisibilityObservations` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `llm_visibility_observations_run_idx` ON `llmVisibilityObservations` (`runId`);--> statement-breakpoint
CREATE INDEX `llm_visibility_observations_query_idx` ON `llmVisibilityObservations` (`queryId`);--> statement-breakpoint
CREATE INDEX `llm_visibility_projects_owner_idx` ON `llmVisibilityProjects` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `llm_visibility_projects_domain_idx` ON `llmVisibilityProjects` (`ownerUserId`,`canonicalDomain`);--> statement-breakpoint
CREATE INDEX `llm_visibility_queries_owner_idx` ON `llmVisibilityQueries` (`ownerUserId`,`active`,`createdAt`);--> statement-breakpoint
CREATE INDEX `llm_visibility_queries_project_idx` ON `llmVisibilityQueries` (`projectId`,`active`);--> statement-breakpoint
CREATE INDEX `llm_visibility_runs_owner_idx` ON `llmVisibilityRuns` (`ownerUserId`,`observedAt`);--> statement-breakpoint
CREATE INDEX `llm_visibility_runs_project_idx` ON `llmVisibilityRuns` (`projectId`,`observedAt`);