CREATE TABLE `siteEvidenceFindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`scanId` int NOT NULL,
	`urlId` int,
	`category` varchar(80) NOT NULL,
	`severity` enum('info','warning','critical') NOT NULL,
	`status` enum('detected','unknown') NOT NULL,
	`evidence` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `siteEvidenceFindings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `siteEvidenceScans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`targetOrigin` varchar(2048) NOT NULL,
	`targetHost` varchar(255) NOT NULL,
	`status` enum('pending','running','completed','completed_partial','failed') NOT NULL DEFAULT 'pending',
	`maxPages` int NOT NULL,
	`pagesDiscovered` int NOT NULL DEFAULT 0,
	`pagesFetched` int NOT NULL DEFAULT 0,
	`renderedCaptured` int NOT NULL DEFAULT 0,
	`errorCode` varchar(80),
	`limitations` json,
	`idempotencyKey` varchar(128) NOT NULL,
	`heartbeatAt` timestamp,
	`startedAt` timestamp,
	`finishedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `siteEvidenceScans_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_evidence_scans_owner_key_unique` UNIQUE(`ownerUserId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `siteEvidenceSitemaps` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`scanId` int NOT NULL,
	`url` varchar(2048) NOT NULL,
	`urlHash` varchar(128) NOT NULL,
	`kind` enum('urlset','sitemapindex','unknown') NOT NULL DEFAULT 'unknown',
	`status` enum('fetched','failed') NOT NULL,
	`httpStatus` int,
	`urlCount` int NOT NULL DEFAULT 0,
	`contentHash` varchar(128),
	`errorCode` varchar(80),
	`discoveredFrom` enum('robots','wellknown','index') NOT NULL,
	`fetchedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `siteEvidenceSitemaps_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `siteEvidenceSnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`scanId` int NOT NULL,
	`urlId` int NOT NULL,
	`kind` enum('raw','rendered') NOT NULL,
	`status` enum('captured','unavailable','failed') NOT NULL,
	`reasonCode` varchar(80),
	`provider` varchar(80),
	`httpStatus` int,
	`contentHash` varchar(128),
	`body` mediumtext,
	`bodyTruncated` boolean NOT NULL DEFAULT false,
	`bytesFetched` int,
	`signals` json,
	`fetchDurationMs` int,
	`fetchedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `siteEvidenceSnapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `siteEvidenceUrls` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`siteHost` varchar(255) NOT NULL,
	`url` varchar(2048) NOT NULL,
	`normalizedUrl` varchar(2048) NOT NULL,
	`urlHash` varchar(128) NOT NULL,
	`lastScanId` int NOT NULL,
	`discoverySources` json NOT NULL,
	`canonicalUrl` varchar(2048),
	`robotsVerdict` enum('allowed','disallowed','unavailable','unknown') NOT NULL DEFAULT 'unknown',
	`robotsMatchedRule` varchar(512),
	`metaRobots` varchar(255),
	`xRobotsTag` varchar(255),
	`httpStatus` int,
	`redirectChain` json,
	`finalUrl` varchar(2048),
	`contentHash` varchar(128),
	`contentType` varchar(128),
	`bytesFetched` int,
	`errorCode` varchar(80),
	`firstSeenAt` timestamp NOT NULL,
	`lastFetchedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `siteEvidenceUrls_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_evidence_urls_owner_hash_unique` UNIQUE(`ownerUserId`,`urlHash`)
);
--> statement-breakpoint
ALTER TABLE `siteEvidenceFindings` ADD CONSTRAINT `sef_scan_fk` FOREIGN KEY (`scanId`) REFERENCES `siteEvidenceScans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceFindings` ADD CONSTRAINT `sef_url_fk` FOREIGN KEY (`urlId`) REFERENCES `siteEvidenceUrls`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceFindings` ADD CONSTRAINT `sef_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceScans` ADD CONSTRAINT `sev_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceSitemaps` ADD CONSTRAINT `sem_scan_fk` FOREIGN KEY (`scanId`) REFERENCES `siteEvidenceScans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceSitemaps` ADD CONSTRAINT `sem_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceSnapshots` ADD CONSTRAINT `ses_scan_fk` FOREIGN KEY (`scanId`) REFERENCES `siteEvidenceScans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceSnapshots` ADD CONSTRAINT `ses_url_fk` FOREIGN KEY (`urlId`) REFERENCES `siteEvidenceUrls`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceSnapshots` ADD CONSTRAINT `ses_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceUrls` ADD CONSTRAINT `seu_last_scan_fk` FOREIGN KEY (`lastScanId`) REFERENCES `siteEvidenceScans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `siteEvidenceUrls` ADD CONSTRAINT `seu_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `site_evidence_findings_scan_category_idx` ON `siteEvidenceFindings` (`scanId`,`category`);--> statement-breakpoint
CREATE INDEX `site_evidence_scans_owner_created_idx` ON `siteEvidenceScans` (`ownerUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `site_evidence_sitemaps_scan_idx` ON `siteEvidenceSitemaps` (`scanId`);--> statement-breakpoint
CREATE INDEX `site_evidence_snapshots_scan_idx` ON `siteEvidenceSnapshots` (`scanId`);--> statement-breakpoint
CREATE INDEX `site_evidence_snapshots_url_kind_idx` ON `siteEvidenceSnapshots` (`urlId`,`kind`);--> statement-breakpoint
CREATE INDEX `site_evidence_urls_owner_host_idx` ON `siteEvidenceUrls` (`ownerUserId`,`siteHost`);--> statement-breakpoint
CREATE INDEX `site_evidence_urls_scan_idx` ON `siteEvidenceUrls` (`lastScanId`);