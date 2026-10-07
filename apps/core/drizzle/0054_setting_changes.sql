CREATE TABLE `setting_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`proposal_id` integer NOT NULL,
	`change` text NOT NULL,
	`undone_at` integer,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setting_changes_proposal` ON `setting_changes` (`proposal_id`);