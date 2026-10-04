CREATE TABLE `github_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`identifier` text,
	`data` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
