CREATE TABLE `weeklyContentSchedulerCursors` (
	`ownerUserId` int NOT NULL,
	`afterConfigId` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `weeklyContentSchedulerCursors_ownerUserId` PRIMARY KEY(`ownerUserId`)
);
--> statement-breakpoint
ALTER TABLE `weeklyContentSchedulerCursors` ADD CONSTRAINT `weekly_scheduler_cursor_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;