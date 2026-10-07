CREATE TABLE `memory_turns` (
	`memory_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` integer NOT NULL,
	`at` integer NOT NULL,
	`did` text NOT NULL,
	`before` text,
	PRIMARY KEY(`memory_id`, `turn_id`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_turns_turn` ON `memory_turns` (`turn_id`);--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `remembered` text DEFAULT '[]' NOT NULL;