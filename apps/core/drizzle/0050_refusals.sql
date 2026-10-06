CREATE TABLE `refusals` (
	`item_id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`entry_id` integer NOT NULL,
	`job` text,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `update_state` ADD `refusals_cursor` integer;