CREATE TABLE `channel_post_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `channel_post_details_channel` ON `channel_post_details` (`team_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `channel_settings` (
	`account` text NOT NULL,
	`team_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`name` text NOT NULL,
	`excluded_at` integer NOT NULL,
	PRIMARY KEY(`account`, `team_id`, `channel_id`)
);
