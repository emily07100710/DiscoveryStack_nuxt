CREATE TABLE `contentOperationAutopilotPolicies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`publicationTargetId` int NOT NULL,
	`policyId` varchar(96) NOT NULL,
	`policyVersion` varchar(96) NOT NULL,
	`authorizedByOwnerUserId` int NOT NULL,
	`status` enum('enabled','paused','revoked') NOT NULL DEFAULT 'enabled',
	`authorizedAt` timestamp NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`allowedContentTypes` json NOT NULL,
	`allowedLanguages` json NOT NULL,
	`requireApprovedForDelivery` boolean NOT NULL DEFAULT true,
	`requirePassedRiskGate` boolean NOT NULL DEFAULT true,
	`configurationFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentOperationAutopilotPolicies_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_autopilot_policy_id_unique` UNIQUE(`policyId`),
	CONSTRAINT `content_operation_autopilot_owner_target_unique` UNIQUE(`ownerUserId`,`publicationTargetId`)
);
--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD CONSTRAINT `contentOperationAutopilotPolicies_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD CONSTRAINT `fk_content_operation_autopi_client_id_19d1865ec4` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD CONSTRAINT `fk_content_operation_autopi_publication_target_1f95300e37` FOREIGN KEY (`publicationTargetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD CONSTRAINT `fk_content_operation_autopi_authorized_by_owne_976f4633f8` FOREIGN KEY (`authorizedByOwnerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `content_operation_autopilot_owner_status_idx` ON `contentOperationAutopilotPolicies` (`ownerUserId`,`status`,`expiresAt`);