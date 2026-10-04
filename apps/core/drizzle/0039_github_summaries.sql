CREATE TABLE `github_summary_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`cadence` text NOT NULL,
	`day` text NOT NULL,
	`written_at` integer NOT NULL,
	`seen_at` integer,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `github_summary_details_cadence_day` ON `github_summary_details` (`cadence`,`day`);