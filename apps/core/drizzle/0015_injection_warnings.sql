CREATE TABLE `injection_warnings` (
	`item_id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`entry_id` integer NOT NULL,
	`via` text NOT NULL,
	`found` text NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE no action
);
