ALTER TABLE `leads` ADD `modelImprovementConsent` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `modelImprovementConsentVersion` varchar(80);--> statement-breakpoint
ALTER TABLE `leads` ADD `modelImprovementConsentAt` timestamp;--> statement-breakpoint
ALTER TABLE `leads` ADD `modelImprovementConsentRevokedAt` timestamp;