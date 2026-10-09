CREATE TABLE `articleWorkbenchFeedback` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceRowId` int NOT NULL,
	`version` int NOT NULL,
	`note` text NOT NULL,
	`actorFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `articleWorkbenchFeedback_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `articleWorkbenchMedia` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceRowId` int NOT NULL,
	`mediaId` varchar(36) NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`mimeType` varchar(24) NOT NULL,
	`size` int NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`url` varchar(2048) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `articleWorkbenchMedia_id` PRIMARY KEY(`id`),
	CONSTRAINT `article_workbench_media_uq` UNIQUE(`mediaId`)
);
--> statement-breakpoint
CREATE TABLE `articleWorkbenchOperations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceRowId` int NOT NULL,
	`operation` enum('save','feedback','approve') NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`actorFingerprint` varchar(64) NOT NULL,
	`resultVersion` int NOT NULL,
	`resultDocumentHash` varchar(64) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `articleWorkbenchOperations_id` PRIMARY KEY(`id`),
	CONSTRAINT `article_workbench_operation_key_uq` UNIQUE(`workspaceRowId`,`operation`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `articleWorkbenchRevisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceRowId` int NOT NULL,
	`version` int NOT NULL,
	`document` json NOT NULL,
	`documentHash` varchar(64) NOT NULL,
	`mediaManifest` json NOT NULL,
	`actorKind` enum('owner','customer') NOT NULL,
	`actorFingerprint` varchar(64) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `articleWorkbenchRevisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `article_workbench_revision_uq` UNIQUE(`workspaceRowId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `articleWorkbenchWorkspaces` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` varchar(35) NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`bindingId` int NOT NULL,
	`bindingFingerprint` varchar(64) NOT NULL,
	`sourceLabel` varchar(40) NOT NULL,
	`authority` json NOT NULL,
	`authorityFingerprint` varchar(64) NOT NULL,
	`document` json NOT NULL,
	`documentHash` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`status` enum('preparing','editing','changes_requested','approved','processing','published','retry_wait','failed','revoked') NOT NULL,
	`remotePostId` varchar(128),
	`remotePostVersion` int,
	`preparationStatus` enum('queued','processing','ready','retry_wait','failed') NOT NULL,
	`preparationAttemptCount` int NOT NULL DEFAULT 0,
	`preparationLeaseToken` varchar(96),
	`preparationLeaseExpiresAt` timestamp(3),
	`preparationRetryEligibleAt` timestamp(3),
	`preparationRetryKey` varchar(36) NOT NULL,
	`preparationPayloadFingerprint` varchar(64),
	`preparationErrorCode` varchar(80),
	`ownerIdempotencyKey` varchar(128) NOT NULL,
	`ownerRequestFingerprint` varchar(64) NOT NULL,
	`approvedVersion` int,
	`approvedDocumentHash` varchar(64),
	`approvedMediaManifestHash` varchar(64),
	`approvalFingerprint` varchar(64),
	`approvedActorFingerprint` varchar(64),
	`approvedAt` timestamp(3),
	`notificationVersion` int NOT NULL DEFAULT 1,
	`notificationStatus` enum('queued','processing','sent','retry_wait','failed') NOT NULL,
	`notificationAttemptCount` int NOT NULL DEFAULT 0,
	`notificationLeaseToken` varchar(96),
	`notificationLeaseExpiresAt` timestamp(3),
	`notificationRetryEligibleAt` timestamp(3),
	`notificationRetryKey` varchar(36) NOT NULL,
	`notificationPayloadFingerprint` varchar(64),
	`notificationProviderMessageId` varchar(128),
	`notificationErrorCode` varchar(80),
	`publicationAttemptCount` int NOT NULL DEFAULT 0,
	`publicationLeaseToken` varchar(96),
	`publicationLeaseExpiresAt` timestamp(3),
	`publicationRetryEligibleAt` timestamp(3),
	`publicationRetryKey` varchar(36) NOT NULL,
	`publicationPayloadFingerprint` varchar(64),
	`publicationErrorCode` varchar(80),
	`publicationUrl` varchar(2048),
	`publicationProviderPostId` varchar(128),
	`publishedAt` timestamp(3),
	`expiresAt` timestamp(3) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `articleWorkbenchWorkspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `article_workbench_workspace_uq` UNIQUE(`workspaceId`),
	CONSTRAINT `article_workbench_owner_key_uq` UNIQUE(`ownerUserId`,`clientId`,`ownerIdempotencyKey`)
);
--> statement-breakpoint
CREATE INDEX `article_workbench_feedback_workspace_idx` ON `articleWorkbenchFeedback` (`workspaceRowId`,`id`);--> statement-breakpoint
CREATE INDEX `article_workbench_media_workspace_idx` ON `articleWorkbenchMedia` (`workspaceRowId`,`id`);--> statement-breakpoint
CREATE INDEX `article_workbench_client_idx` ON `articleWorkbenchWorkspaces` (`ownerUserId`,`clientId`,`id`);--> statement-breakpoint
CREATE INDEX `article_workbench_binding_idx` ON `articleWorkbenchWorkspaces` (`bindingId`,`status`);