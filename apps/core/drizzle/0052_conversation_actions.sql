ALTER TABLE `conversation_turns` ADD `proposal_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `conversation_id` text;--> statement-breakpoint
ALTER TABLE `proposals` ADD `conversation_turn_id` integer;