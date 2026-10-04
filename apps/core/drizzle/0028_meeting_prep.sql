CREATE TABLE `meeting_prep_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `meeting_prep_details_event` ON `meeting_prep_details` (`event_id`);