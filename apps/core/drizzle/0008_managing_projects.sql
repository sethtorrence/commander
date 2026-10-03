CREATE TABLE `project_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`project_id` text,
	`merged_id` text,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`item_entries` text NOT NULL,
	`undoes` integer,
	FOREIGN KEY (`undoes`) REFERENCES `project_changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_changes_undoes` ON `project_changes` (`undoes`);--> statement-breakpoint
DROP INDEX `projects_code`;--> statement-breakpoint
ALTER TABLE `projects` ADD `merged_into` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_code` ON `projects` (`code`) WHERE "projects"."merged_into" IS NULL;