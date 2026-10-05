CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`keywords` text DEFAULT '' NOT NULL,
	`confirmed` integer NOT NULL,
	`by` text NOT NULL,
	`key` text,
	`person_id` text,
	`project_id` text,
	`handles` text NOT NULL,
	`learned_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`edited_at` integer,
	`kept_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_key` ON `memories` (`key`);--> statement-breakpoint
CREATE INDEX `memories_person` ON `memories` (`person_id`);--> statement-breakpoint
CREATE INDEX `memories_project` ON `memories` (`project_id`);--> statement-breakpoint
CREATE TABLE `memory_progress` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_sources` (
	`memory_id` text NOT NULL,
	`item_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`memory_id`, `item_id`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_sources_item` ON `memory_sources` (`item_id`);