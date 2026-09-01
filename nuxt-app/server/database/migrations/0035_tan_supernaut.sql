CREATE TABLE `knowledgeClaimDisputes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`claimAId` int NOT NULL,
	`claimBId` int NOT NULL,
	`detectionMethod` enum('shared_source_conflict','manual') NOT NULL,
	`detectionReason` varchar(500) NOT NULL,
	`status` enum('open','resolved') NOT NULL DEFAULT 'open',
	`resolution` enum('kept_a','kept_b','both_stand','other'),
	`resolutionNote` text,
	`resolvedAt` datetime,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeClaimDisputes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeClaimEntityLinks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`claimId` int NOT NULL,
	`entityId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeClaimEntityLinks_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_claim_entity_link_unique` UNIQUE(`claimId`,`entityId`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeClaimEvidence` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`claimId` int NOT NULL,
	`sourceVersionId` int NOT NULL,
	`relation` enum('supports','contradicts','contextualizes','supersedes') NOT NULL,
	`locator` varchar(500) NOT NULL,
	`locatorHash` varchar(64) NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`reviewNotes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeClaimEvidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_claim_evidence_locator_unique` UNIQUE(`claimId`,`sourceVersionId`,`relation`,`locatorHash`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeClaimStatusEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`claimId` int NOT NULL,
	`fromStatus` enum('unverified','source_backed','independently_confirmed','first_party_measured','disputed','expired','retracted') NOT NULL,
	`toStatus` enum('unverified','source_backed','independently_confirmed','first_party_measured','disputed','expired','retracted') NOT NULL,
	`reason` varchar(500) NOT NULL,
	`triggeredBy` enum('system','owner') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeClaimStatusEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeClaims` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`statement` text NOT NULL,
	`claimType` enum('statistics','pricing','laws and regulations','medical / financial / legal claims','product capabilities','research findings','competitive comparisons','first-party measurements','time-sensitive facts') NOT NULL,
	`status` enum('unverified','source_backed','independently_confirmed','first_party_measured','disputed','expired','retracted') NOT NULL DEFAULT 'unverified',
	`validFrom` datetime,
	`validTo` datetime,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeClaims_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeContentEntityLinks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`briefId` int NOT NULL,
	`entityId` int NOT NULL,
	`role` enum('author','about','mentions') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeContentEntityLinks_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_content_entity_role_unique` UNIQUE(`briefId`,`entityId`,`role`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeEntities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`entityUid` varchar(32) NOT NULL,
	`entityType` enum('Person','Organization','Brand','Product','Service','Concept','Topic','Location','Author','Research','Dataset','Claim','Source','Article','Question','Event','Statistic') NOT NULL,
	`canonicalName` varchar(255) NOT NULL,
	`slug` varchar(160),
	`canonicalUri` varchar(500),
	`canonicalUriHash` varchar(64),
	`locale` varchar(16),
	`summary` text,
	`status` enum('active','merged','retired') NOT NULL DEFAULT 'active',
	`publicVisibility` enum('private','public_candidate') NOT NULL DEFAULT 'private',
	`mergedIntoEntityId` int,
	`provenance` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeEntities_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_entities_uid_unique` UNIQUE(`entityUid`),
	CONSTRAINT `knowledge_entities_owner_uri_hash_unique` UNIQUE(`ownerUserId`,`canonicalUriHash`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeEntityAliases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`entityId` int NOT NULL,
	`alias` varchar(255) NOT NULL,
	`aliasNormalized` varchar(255) NOT NULL,
	`locale` varchar(16),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeEntityAliases_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_entity_alias_normalized_unique` UNIQUE(`entityId`,`aliasNormalized`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeEntityEdges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`subjectEntityId` int NOT NULL,
	`predicate` enum('worksFor','about','authoredBy','supportedBy','offeredBy','supports','answeredBy','mentions','producedBy') NOT NULL,
	`objectEntityId` int NOT NULL,
	`validFrom` datetime,
	`validTo` datetime,
	`sourceId` int,
	`verificationStatus` enum('unverified','verified','disputed') NOT NULL DEFAULT 'unverified',
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeEntityEdges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeEntityExternalIds` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`entityId` int NOT NULL,
	`idType` varchar(64) NOT NULL,
	`idValue` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeEntityExternalIds_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_external_id_owner_value_unique` UNIQUE(`ownerUserId`,`idType`,`idValue`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeEntityMergeCandidates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceEntityId` int NOT NULL,
	`targetEntityId` int NOT NULL,
	`matchMethod` enum('exact_external_id','exact_canonical_uri','normalized_name') NOT NULL,
	`matchDetail` json NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`decisionNote` varchar(500),
	`decidedAt` datetime,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeEntityMergeCandidates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeEntityMergeEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceEntityId` int NOT NULL,
	`targetEntityId` int NOT NULL,
	`candidateId` int,
	`reason` varchar(500) NOT NULL,
	`undoneAt` datetime,
	`undoReason` varchar(500),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeEntityMergeEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledgePublisherSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`organizationEntityId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgePublisherSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_publisher_settings_owner_unique` UNIQUE(`ownerUserId`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeSourceVersions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceId` int NOT NULL,
	`versionNumber` int NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`retrievedAt` datetime NOT NULL,
	`excerpt` text,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeSourceVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_source_version_number_unique` UNIQUE(`sourceId`,`versionNumber`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeSources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`canonicalUrl` varchar(500) NOT NULL,
	`urlHash` varchar(64) NOT NULL,
	`title` varchar(255),
	`sourceClass` enum('official documentation','government','academic / peer-reviewed','primary research','first-party company data','major publication','secondary media','expert publication','blog','forum','social','unknown') NOT NULL,
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeSources_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_sources_owner_url_hash_unique` UNIQUE(`ownerUserId`,`urlHash`)
);
--> statement-breakpoint
ALTER TABLE `knowledgeClaimDisputes` ADD CONSTRAINT `fk_knowledge_claim_disputes_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimDisputes` ADD CONSTRAINT `fk_knowledge_dispute_claim_a` FOREIGN KEY (`claimAId`) REFERENCES `knowledgeClaims`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimDisputes` ADD CONSTRAINT `fk_knowledge_dispute_claim_b` FOREIGN KEY (`claimBId`) REFERENCES `knowledgeClaims`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimEntityLinks` ADD CONSTRAINT `fk_knowledge_claim_entity_links_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimEntityLinks` ADD CONSTRAINT `fk_knowledge_claim_entity_link_claim` FOREIGN KEY (`claimId`) REFERENCES `knowledgeClaims`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimEntityLinks` ADD CONSTRAINT `fk_knowledge_claim_entity_link_entity` FOREIGN KEY (`entityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimEvidence` ADD CONSTRAINT `fk_knowledge_claim_evidence_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimEvidence` ADD CONSTRAINT `fk_knowledge_claim_evidence_claim` FOREIGN KEY (`claimId`) REFERENCES `knowledgeClaims`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimEvidence` ADD CONSTRAINT `fk_knowledge_claim_evidence_version` FOREIGN KEY (`sourceVersionId`) REFERENCES `knowledgeSourceVersions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimStatusEvents` ADD CONSTRAINT `fk_knowledge_claim_status_events_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaimStatusEvents` ADD CONSTRAINT `fk_knowledge_claim_status_event_claim` FOREIGN KEY (`claimId`) REFERENCES `knowledgeClaims`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeClaims` ADD CONSTRAINT `fk_knowledge_claims_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeContentEntityLinks` ADD CONSTRAINT `fk_knowledge_content_entity_links_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeContentEntityLinks` ADD CONSTRAINT `fk_knowledge_content_link_brief` FOREIGN KEY (`briefId`) REFERENCES `seoGeoContentBriefs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeContentEntityLinks` ADD CONSTRAINT `fk_knowledge_content_link_entity` FOREIGN KEY (`entityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntities` ADD CONSTRAINT `fk_knowledge_entities_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntities` ADD CONSTRAINT `fk_knowledge_entities_merged_into` FOREIGN KEY (`mergedIntoEntityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityAliases` ADD CONSTRAINT `fk_knowledge_entity_aliases_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityAliases` ADD CONSTRAINT `fk_knowledge_entity_alias_entity` FOREIGN KEY (`entityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityEdges` ADD CONSTRAINT `fk_knowledge_entity_edges_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityEdges` ADD CONSTRAINT `fk_knowledge_edge_subject_entity` FOREIGN KEY (`subjectEntityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityEdges` ADD CONSTRAINT `fk_knowledge_edge_object_entity` FOREIGN KEY (`objectEntityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityEdges` ADD CONSTRAINT `fk_knowledge_edge_source` FOREIGN KEY (`sourceId`) REFERENCES `knowledgeSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityExternalIds` ADD CONSTRAINT `fk_knowledge_entity_external_ids_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityExternalIds` ADD CONSTRAINT `fk_knowledge_external_id_entity` FOREIGN KEY (`entityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityMergeCandidates` ADD CONSTRAINT `fk_knowledge_merge_candidates_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityMergeCandidates` ADD CONSTRAINT `fk_knowledge_merge_candidate_source` FOREIGN KEY (`sourceEntityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityMergeCandidates` ADD CONSTRAINT `fk_knowledge_merge_candidate_target` FOREIGN KEY (`targetEntityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityMergeEvents` ADD CONSTRAINT `fk_knowledge_merge_events_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityMergeEvents` ADD CONSTRAINT `fk_knowledge_merge_event_source` FOREIGN KEY (`sourceEntityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityMergeEvents` ADD CONSTRAINT `fk_knowledge_merge_event_target` FOREIGN KEY (`targetEntityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeEntityMergeEvents` ADD CONSTRAINT `fk_knowledge_merge_event_candidate` FOREIGN KEY (`candidateId`) REFERENCES `knowledgeEntityMergeCandidates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgePublisherSettings` ADD CONSTRAINT `fk_knowledge_publisher_settings_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgePublisherSettings` ADD CONSTRAINT `fk_knowledge_publisher_organization` FOREIGN KEY (`organizationEntityId`) REFERENCES `knowledgeEntities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeSourceVersions` ADD CONSTRAINT `fk_knowledge_source_versions_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeSourceVersions` ADD CONSTRAINT `fk_knowledge_source_version_source` FOREIGN KEY (`sourceId`) REFERENCES `knowledgeSources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeSources` ADD CONSTRAINT `fk_knowledge_sources_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `knowledge_disputes_owner_status_idx` ON `knowledgeClaimDisputes` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_disputes_claim_pair_idx` ON `knowledgeClaimDisputes` (`claimAId`,`claimBId`);--> statement-breakpoint
CREATE INDEX `knowledge_claim_status_events_claim_idx` ON `knowledgeClaimStatusEvents` (`claimId`);--> statement-breakpoint
CREATE INDEX `knowledge_claims_owner_status_idx` ON `knowledgeClaims` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_entities_owner_type_idx` ON `knowledgeEntities` (`ownerUserId`,`entityType`);--> statement-breakpoint
CREATE INDEX `knowledge_entities_owner_name_idx` ON `knowledgeEntities` (`ownerUserId`,`canonicalName`);--> statement-breakpoint
CREATE INDEX `knowledge_entity_edges_subject_idx` ON `knowledgeEntityEdges` (`subjectEntityId`);--> statement-breakpoint
CREATE INDEX `knowledge_entity_edges_object_idx` ON `knowledgeEntityEdges` (`objectEntityId`);--> statement-breakpoint
CREATE INDEX `knowledge_merge_candidates_owner_status_idx` ON `knowledgeEntityMergeCandidates` (`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_merge_events_source_idx` ON `knowledgeEntityMergeEvents` (`sourceEntityId`);--> statement-breakpoint
CREATE INDEX `knowledge_source_version_hash_idx` ON `knowledgeSourceVersions` (`sourceId`,`contentHash`);