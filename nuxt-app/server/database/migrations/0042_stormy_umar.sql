CREATE TABLE `managedSiteContactSubmissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`submittedName` varchar(160) NOT NULL,
	`submittedEmail` varchar(320) NOT NULL,
	`submittedPhone` varchar(64),
	`submittedMessage` text NOT NULL,
	`status` enum('received','forwarded','forward_failed') NOT NULL DEFAULT 'received',
	`forwardTargetEmail` varchar(320),
	`forwardedAt` timestamp,
	`forwardErrorCode` varchar(64),
	`requestFingerprint` varchar(128) NOT NULL,
	`dedupeKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `managedSiteContactSubmissions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteProjects` ADD `contactFormTokenVersion` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `managedSiteProjects` ADD `contactFormTokenHash` varchar(128);--> statement-breakpoint
ALTER TABLE `managedSiteContactSubmissions` ADD CONSTRAINT `ms_contact_submission_project_fk` FOREIGN KEY (`projectId`) REFERENCES `managedSiteProjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ms_contact_submission_project_idx` ON `managedSiteContactSubmissions` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ms_contact_submission_dedupe_idx` ON `managedSiteContactSubmissions` (`dedupeKey`);--> statement-breakpoint
CREATE INDEX `ms_projects_contact_form_token_idx` ON `managedSiteProjects` (`contactFormTokenHash`);