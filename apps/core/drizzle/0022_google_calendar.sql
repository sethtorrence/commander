CREATE TABLE `calendars` (
	`account` text NOT NULL,
	`source` text NOT NULL,
	`calendar_id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`primary` integer NOT NULL,
	`access_role` text NOT NULL,
	`on` integer,
	`position` integer NOT NULL,
	PRIMARY KEY(`account`, `calendar_id`)
);
--> statement-breakpoint
CREATE TABLE `event_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `event_details_range` ON `event_details` (`start_at`,`end_at`);--> statement-breakpoint
CREATE INDEX `event_details_calendar` ON `event_details` (`calendar_id`);