CREATE TABLE `chat_settings` (
	`account` text NOT NULL,
	`chat_id` text NOT NULL,
	`name` text NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`excluded_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account`, `chat_id`)
);
