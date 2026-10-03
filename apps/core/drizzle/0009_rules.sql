CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`target` text NOT NULL,
	`when` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
ALTER TABLE `project_changes` ADD `rule_moves` text DEFAULT '[]' NOT NULL;