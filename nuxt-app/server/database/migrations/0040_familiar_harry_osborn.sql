CREATE TABLE `managedSiteModuleFulfilments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`draftOrderId` int NOT NULL,
	`quoteId` int NOT NULL,
	`moduleKey` enum('managed_content_admin','bounded_ai_assistant','shopify_commerce','line_assisted_integration','google_booking_assisted_integration','geo_content_subscription','geo_measurement_dashboard','pwa_reference_only','stripe_payment','newebpay_payment','ecpay_payment','einvoice','logistics','erp_crm_backoffice') NOT NULL,
	`mode` enum('automatic','manual_service') NOT NULL,
	`status` enum('automatic','pending_manual_setup','manual_setup_completed','recorded_intent_unbilled','cancelled') NOT NULL,
	`billedMinor` int NOT NULL,
	`customerVisibleStatus` varchar(120) NOT NULL,
	`ownerActionRequired` boolean NOT NULL,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `managedSiteModuleFulfilments_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_site_module_fulfilment_order_module_unique` UNIQUE(`draftOrderId`,`moduleKey`)
);
--> statement-breakpoint
ALTER TABLE `managedSiteModuleFulfilments` ADD CONSTRAINT `fk_ms_module_fulfilment_owner` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteModuleFulfilments` ADD CONSTRAINT `fk_ms_module_fulfilment_order` FOREIGN KEY (`draftOrderId`) REFERENCES `managedSiteDraftOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `managedSiteModuleFulfilments` ADD CONSTRAINT `fk_ms_module_fulfilment_quote` FOREIGN KEY (`quoteId`) REFERENCES `managedSiteQuotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `managed_site_module_fulfilment_owner_status_idx` ON `managedSiteModuleFulfilments` (`ownerUserId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `managed_site_module_fulfilment_owner_order_idx` ON `managedSiteModuleFulfilments` (`ownerUserId`,`draftOrderId`);