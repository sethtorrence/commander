CREATE TABLE `update_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group` text NOT NULL,
	`merge_key` text NOT NULL,
	`about` text NOT NULL,
	`item_ids` text NOT NULL,
	`section` text NOT NULL,
	`importance` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`snoozed_until` integer,
	`status` text NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE INDEX `update_queue_status` ON `update_queue` (`status`);--> statement-breakpoint
CREATE INDEX `update_queue_merge_key` ON `update_queue` (`merge_key`);--> statement-breakpoint
CREATE TABLE `update_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`proposals_cursor` integer,
	`warnings_cursor` integer,
	`last_input_at` integer,
	`longest_gap_ms` integer DEFAULT 0 NOT NULL,
	`last_given_at` integer
);
--> statement-breakpoint
CREATE TABLE `updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`away_ms` integer NOT NULL,
	`folded` integer NOT NULL,
	`voice` text NOT NULL,
	`lines` text NOT NULL
);
