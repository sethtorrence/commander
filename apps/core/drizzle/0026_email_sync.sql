CREATE TABLE `email_bodies` (
	`item_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`html` text,
	`text_from_html` integer NOT NULL,
	`truncated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`thread_key` text NOT NULL,
	`source_thread_id` text,
	`sent_at` integer NOT NULL,
	`unread` integer NOT NULL,
	`in_inbox` integer NOT NULL,
	`has_attachments` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_details_thread` ON `email_details` (`thread_key`);--> statement-breakpoint
CREATE INDEX `email_details_source_thread` ON `email_details` (`source_thread_id`);--> statement-breakpoint
CREATE INDEX `email_details_sent_at` ON `email_details` (`sent_at`);--> statement-breakpoint
CREATE TABLE `email_message_ids` (
	`item_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`item_id`, `message_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_message_ids_message` ON `email_message_ids` (`message_id`);