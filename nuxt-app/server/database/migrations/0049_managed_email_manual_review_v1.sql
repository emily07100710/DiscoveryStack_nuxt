CREATE TABLE `managedSiteEmailManualReviews` (
	`outboxId` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`requestId` varchar(36) NOT NULL,
	`outboxVersion` varchar(64) NOT NULL,
	`reason` enum('reviewed_no_resend','handled_outside_platform') NOT NULL,
	`closedAt` datetime(3) NOT NULL,
	CONSTRAINT `managedSiteEmailManualReviews_outboxId` PRIMARY KEY(`outboxId`),
	CONSTRAINT `managed_email_review_request_uq` UNIQUE(`ownerUserId`,`requestId`)
);
--> statement-breakpoint
CREATE INDEX `managed_email_review_owner_idx` ON `managedSiteEmailManualReviews` (`ownerUserId`,`closedAt`,`outboxId`);