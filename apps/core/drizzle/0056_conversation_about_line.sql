ALTER TABLE `conversations` ADD `about_update_id` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `about_queued_id` integer;--> statement-breakpoint
CREATE INDEX `conversations_about_queued` ON `conversations` (`about_queued_id`);