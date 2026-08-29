CREATE TABLE `contentOperationCalendarEntryTargets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`clientId` int NOT NULL,
	`entryId` int NOT NULL,
	`targetId` int NOT NULL,
	`slot` int NOT NULL,
	`bindingFingerprint` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contentOperationCalendarEntryTargets_id` PRIMARY KEY(`id`),
	CONSTRAINT `content_operation_entry_targets_owner_entry_target_unique` UNIQUE(`ownerUserId`,`entryId`,`targetId`),
	CONSTRAINT `content_operation_entry_targets_owner_entry_slot_unique` UNIQUE(`ownerUserId`,`entryId`,`slot`)
);
--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` MODIFY COLUMN `framework` enum('astro','nuxt','wordpress','php_agent','generic_http','geoflow_local','static_site') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` MODIFY COLUMN `transport` enum('first_party_git','first_party_signed_api','wordpress_rest','geoflow_agent','generic_http','geoflow_local') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `cadenceDays` int DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `evidenceFreshnessHours` int DEFAULT 720 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `maximumRiskLevel` varchar(40) DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `requiredQualityGateVersion` varchar(96) DEFAULT 'geo-content-quality-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedTargetIds` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `allowedProviderModels` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationAutopilotPolicies` ADD `activatedAt` timestamp DEFAULT (now()) NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `publicationContentHash` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `publicationRoutingPlanId` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `publicationAuthorityReference` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntries` ADD `publicationTargetCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `websiteId` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `deliverableId` int;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `draftId` int;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `routingPlanId` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `routeId` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `executorRunId` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `contentHash` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `evidenceSnapshotHash` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD `authorityReference` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD `targetId` int;--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD `draftId` int;--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD `publicationReceiptFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD `publishedUrl` varchar(2048);--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD `contentHash` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD `evidenceSnapshotHash` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `websiteId` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `routingPlanId` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `routeId` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `executorRunId` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `authorityReference` varchar(160);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `receiptFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `publicationUrl` varchar(2048);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `receiptLedger` json;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationAttempts` ADD `publicationContentHash` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` ADD `websiteId` varchar(128) DEFAULT 'legacy-website' NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` ADD `destinationPublicationIdentity` varchar(256) DEFAULT 'legacy-destination' NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` ADD `serviceReference` varchar(128);--> statement-breakpoint
ALTER TABLE `contentOperationPublicationTargets` ADD `provenance` json DEFAULT ('{}') NOT NULL;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntryTargets` ADD CONSTRAINT `contentOperationCalendarEntryTargets_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntryTargets` ADD CONSTRAINT `fk_content_operation_calend_client_id_03ac90030a` FOREIGN KEY (`clientId`) REFERENCES `contentOperationClients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntryTargets` ADD CONSTRAINT `fk_content_operation_calend_entry_id_82d007b891` FOREIGN KEY (`entryId`) REFERENCES `contentOperationCalendarEntries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationCalendarEntryTargets` ADD CONSTRAINT `fk_content_operation_calend_target_id_dcd23157bb` FOREIGN KEY (`targetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `content_operation_entry_targets_owner_client_idx` ON `contentOperationCalendarEntryTargets` (`ownerUserId`,`clientId`);--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD CONSTRAINT `fk_content_operation_events_deliverable_id_afdfcd6132` FOREIGN KEY (`deliverableId`) REFERENCES `seoGeoProductionDeliverables`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationEvents` ADD CONSTRAINT `contentOperationEvents_draftId_seoGeoContentDrafts_id_fk` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD CONSTRAINT `fk_content_operation_outcom_target_id_5183c5f472` FOREIGN KEY (`targetId`) REFERENCES `contentOperationPublicationTargets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contentOperationOutcomeAssessments` ADD CONSTRAINT `fk_content_operation_outcom_draft_id_28ea2a8e88` FOREIGN KEY (`draftId`) REFERENCES `seoGeoContentDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `content_operation_targets_owner_website_idx` ON `contentOperationPublicationTargets` (`ownerUserId`,`websiteId`);