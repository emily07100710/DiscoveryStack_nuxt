CREATE TABLE `knowledgeConsumerBindings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`consumerKind` enum('geo_dataset','benchmark_prompt') NOT NULL,
	`consumerId` int NOT NULL,
	`consumerVersion` varchar(80) NOT NULL,
	`consumerContentHash` varchar(64) NOT NULL,
	`subjectKind` enum('entity','claim','source') NOT NULL,
	`subjectId` int NOT NULL,
	`revisionId` int NOT NULL,
	`revisionNumber` int NOT NULL,
	`revisionContentHash` varchar(64) NOT NULL,
	`revisionFingerprint` varchar(64) NOT NULL,
	`operation` enum('bind','revoke') NOT NULL,
	`sequenceNumber` int NOT NULL,
	`previousBindingFingerprint` varchar(64),
	`bindingFingerprint` varchar(64) NOT NULL,
	`requestFingerprint` varchar(64) NOT NULL,
	`idempotencyKey` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledgeConsumerBindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `kcb_sequence_uq` UNIQUE(`ownerUserId`,`consumerKind`,`consumerId`,`subjectKind`,`subjectId`,`sequenceNumber`),
	CONSTRAINT `kcb_command_uq` UNIQUE(`ownerUserId`,`idempotencyKey`),
	CONSTRAINT `kcb_fingerprint_uq` UNIQUE(`ownerUserId`,`bindingFingerprint`)
);
--> statement-breakpoint
ALTER TABLE `knowledgeConsumerBindings` ADD CONSTRAINT `kcb_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeConsumerBindings` ADD CONSTRAINT `kcb_revision_fk` FOREIGN KEY (`revisionId`) REFERENCES `knowledgeSubjectRevisions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `kcb_owner_consumer_idx` ON `knowledgeConsumerBindings` (`ownerUserId`,`consumerKind`,`consumerId`);