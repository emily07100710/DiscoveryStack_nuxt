CREATE TABLE `publicIntelligenceSourceReviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceId` int NOT NULL,
	`reviewerUserId` int NOT NULL,
	`action` enum('created','reviewed','approved','use_changed','removed','restored') NOT NULL,
	`previousAllowedUse` enum('research_only','evaluation_candidate','training_candidate','blocked'),
	`nextAllowedUse` enum('research_only','evaluation_candidate','training_candidate','blocked') NOT NULL,
	`previousReviewStatus` enum('pending','approved','needs_policy_review','rejected','removed'),
	`nextReviewStatus` enum('pending','approved','needs_policy_review','rejected','removed') NOT NULL,
	`policySnapshot` json NOT NULL,
	`reviewNote` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `publicIntelligenceSourceReviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `publicIntelligenceSourceReviews` ADD CONSTRAINT `pisr_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `publicIntelligenceSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publicIntelligenceSourceReviews` ADD CONSTRAINT `pisr_reviewer_fk` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `public_intelligence_source_reviews_source_idx` ON `publicIntelligenceSourceReviews` (`sourceId`,`createdAt`);
