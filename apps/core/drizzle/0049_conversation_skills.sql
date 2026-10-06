ALTER TABLE `conversation_turns` ADD `links` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `update_id` integer;--> statement-breakpoint
ALTER TABLE `conversation_turns` ADD `skills` text DEFAULT '[]' NOT NULL;