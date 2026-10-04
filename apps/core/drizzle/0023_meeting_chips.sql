CREATE TABLE `calendar_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`heads_up` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meeting_chips` (
	`daily_note_id` text NOT NULL,
	`event_id` text NOT NULL,
	`block_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`daily_note_id`, `event_id`),
	FOREIGN KEY (`daily_note_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`block_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `meeting_chips_block` ON `meeting_chips` (`block_id`);