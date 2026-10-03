CREATE TABLE `autonomy_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`action_kind` text NOT NULL,
	`action` text NOT NULL,
	`section` text,
	`item_id` text NOT NULL,
	`item_actions` text NOT NULL,
	`confidence` real NOT NULL,
	`reason` text NOT NULL,
	`caused_by_item_id` text,
	`caused_by_entry_id` integer,
	`chained` integer NOT NULL,
	`decision` text NOT NULL,
	`status` text NOT NULL,
	`settled_at` integer,
	`entry_ids` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`caused_by_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`caused_by_entry_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `proposals_item` ON `proposals` (`item_id`);--> statement-breakpoint
CREATE INDEX `proposals_status` ON `proposals` (`status`);