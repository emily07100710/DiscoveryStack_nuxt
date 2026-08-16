CREATE TABLE `providerCredentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`firecrawlApiKeyCiphertext` text,
	`huggingFaceApiTokenCiphertext` text,
	`huggingFaceNamespace` varchar(200),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `providerCredentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `provider_credentials_owner_unique` UNIQUE(`ownerUserId`)
);
--> statement-breakpoint
ALTER TABLE `providerCredentials` ADD CONSTRAINT `providerCredentials_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;