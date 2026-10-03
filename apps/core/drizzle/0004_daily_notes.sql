CREATE TABLE `block_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`daily_note_id` text NOT NULL,
	`parent_id` text,
	`position` text NOT NULL,
	`text` text NOT NULL,
	`folded` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`daily_note_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `block_details_daily_note` ON `block_details` (`daily_note_id`);--> statement-breakpoint
CREATE TABLE `daily_note_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_note_details_day_unique` ON `daily_note_details` (`day`);