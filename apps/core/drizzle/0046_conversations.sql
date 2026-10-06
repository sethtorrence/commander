CREATE TABLE `conversation_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`by` text NOT NULL,
	`text` text NOT NULL,
	`at` integer NOT NULL,
	`status` text NOT NULL,
	`reply_to` integer,
	`own_knowledge` integer DEFAULT false NOT NULL,
	`problem` text,
	`ended_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_turns_conversation` ON `conversation_turns` (`conversation_id`,`id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`day` text NOT NULL,
	`daily_of` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_daily_of` ON `conversations` (`daily_of`);--> statement-breakpoint
CREATE INDEX `conversations_updated` ON `conversations` (`updated_at`);