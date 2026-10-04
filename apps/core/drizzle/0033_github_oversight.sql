CREATE TABLE `github_oversight_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`long_running_days` integer NOT NULL,
	`idle_days` integer NOT NULL,
	`bots` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `github_details` ADD `writer_detail` text;