CREATE TABLE `linear_issue_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account` text NOT NULL,
	`source` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`tombstoned` integer NOT NULL,
	`unchanged` integer NOT NULL,
	`requests` integer NOT NULL,
	`complexity` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_account` ON `sync_runs` (`account`,`started_at`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`account` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`cadence_minutes` integer,
	`cursor` text,
	`last_synced_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`problem` text
);
