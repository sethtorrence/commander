CREATE TABLE `busy_copies` (
	`event_id` text NOT NULL,
	`target_account` text NOT NULL,
	`copy_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `target_account`),
	FOREIGN KEY (`event_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`copy_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `busy_copies_copy` ON `busy_copies` (`copy_id`);--> statement-breakpoint
CREATE TABLE `focus_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL
);
