CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`user_name` text,
	`merged_into` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `people_merged_into` ON `people` (`merged_into`);--> statement-breakpoint
CREATE TABLE `people_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`person_id` text NOT NULL,
	`other_id` text,
	`why` text,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`undoes` integer,
	FOREIGN KEY (`undoes`) REFERENCES `people_changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_changes_undoes` ON `people_changes` (`undoes`);--> statement-breakpoint
CREATE TABLE `person_handles` (
	`handle` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`name` text,
	`pinned` integer DEFAULT false NOT NULL,
	`own` integer DEFAULT false NOT NULL,
	`seen_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `person_handles_person` ON `person_handles` (`person_id`);