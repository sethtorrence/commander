CREATE TABLE `suggested_replies` (
	`account` text NOT NULL,
	`thread_key` text NOT NULL,
	`answering` text NOT NULL,
	`body` text NOT NULL,
	`added_links` text NOT NULL,
	`confidence` real NOT NULL,
	`status` text NOT NULL,
	`draft_item_id` text,
	`at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account`, `thread_key`)
);
--> statement-breakpoint
CREATE INDEX `suggested_replies_answering` ON `suggested_replies` (`answering`);