CREATE TABLE `knowledgeConsumerBindingHeads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`consumerKind` enum('geo_dataset','benchmark_prompt') NOT NULL,
	`consumerId` int NOT NULL,
	`subjectKind` enum('entity','claim','source') NOT NULL,
	`subjectId` int NOT NULL,
	`sequenceNumber` int NOT NULL,
	`bindingId` int NOT NULL,
	`bindingFingerprint` varchar(64) NOT NULL,
	CONSTRAINT `knowledgeConsumerBindingHeads_id` PRIMARY KEY(`id`),
	CONSTRAINT `kcbh_identity_uq` UNIQUE(`ownerUserId`,`consumerKind`,`consumerId`,`subjectKind`,`subjectId`),
	CONSTRAINT `kcbh_binding_uq` UNIQUE(`bindingId`)
);
--> statement-breakpoint
ALTER TABLE `knowledgeConsumerBindings` DROP INDEX `kcb_command_uq`;--> statement-breakpoint
ALTER TABLE `knowledgeConsumerBindings` ADD `idempotencyKeyHash` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledgeConsumerBindings` ADD CONSTRAINT `kcb_command_hash_uq` UNIQUE(`ownerUserId`,`idempotencyKeyHash`);--> statement-breakpoint
ALTER TABLE `knowledgeConsumerBindingHeads` ADD CONSTRAINT `kcbh_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `knowledgeConsumerBindingHeads` ADD CONSTRAINT `kcbh_binding_fk` FOREIGN KEY (`bindingId`) REFERENCES `knowledgeConsumerBindings`(`id`) ON DELETE no action ON UPDATE no action;