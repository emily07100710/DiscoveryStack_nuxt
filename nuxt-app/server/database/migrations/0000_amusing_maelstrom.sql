CREATE TABLE `leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`email` varchar(320) NOT NULL,
	`company` varchar(160) NOT NULL,
	`website` varchar(2048),
	`packageInterest` enum('discover','clarify','grow','unsure') NOT NULL,
	`language` enum('en','zh-hant') NOT NULL,
	`message` text,
	`privacyConsent` boolean NOT NULL,
	`recontactConsent` boolean NOT NULL DEFAULT false,
	`status` enum('new','contacted','qualified','closed') NOT NULL DEFAULT 'new',
	`dedupeKey` varchar(64) NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `leads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`name` text,
	`email` varchar(320),
	`loginMethod` varchar(64),
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`)
);
--> statement-breakpoint
CREATE INDEX `leads_dedupe_key_idx` ON `leads` (`dedupeKey`);--> statement-breakpoint
CREATE INDEX `leads_created_at_idx` ON `leads` (`createdAt`);