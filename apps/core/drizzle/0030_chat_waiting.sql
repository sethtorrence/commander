CREATE TABLE `chat_waiting` (
	`item_id` text PRIMARY KEY NOT NULL,
	`judged_through` integer,
	`message_id` text,
	`reason` text,
	`flagged_at` integer,
	`cleared_at` integer,
	`cleared_by` text,
	`clear_entry_id` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`clear_entry_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE no action
);
