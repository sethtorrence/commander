CREATE TABLE `chat_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `activity` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `last_full_sync_at` integer;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `also_after_other_sources` integer;