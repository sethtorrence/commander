CREATE TABLE `email_compose` (
	`item_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`reply_to_item_id` text,
	`body` text NOT NULL,
	`attachments` text NOT NULL,
	`quote_html` text,
	`quote_text` text,
	`message_id` text NOT NULL,
	`send_at` integer,
	`source_text` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_compose_message_id` ON `email_compose` (`message_id`);--> statement-breakpoint
CREATE TABLE `email_compose_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`default_account` text,
	`undo_seconds` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_signatures` (
	`account` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `email_details` ADD `draft` integer DEFAULT false NOT NULL;