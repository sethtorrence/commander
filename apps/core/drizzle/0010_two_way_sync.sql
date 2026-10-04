CREATE TABLE `outgoing_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account` text NOT NULL,
	`source` text NOT NULL,
	`item_id` text NOT NULL,
	`external_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`synced` text,
	`made_at` integer NOT NULL,
	`entry_id` integer,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`error` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outgoing_changes_account` ON `outgoing_changes` (`account`);--> statement-breakpoint
CREATE INDEX `outgoing_changes_item` ON `outgoing_changes` (`item_id`);--> statement-breakpoint
CREATE TABLE `source_catalogs` (
	`account` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`catalog` text NOT NULL,
	`fetched_at` integer NOT NULL
);
