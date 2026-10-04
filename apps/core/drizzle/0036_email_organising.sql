ALTER TABLE `email_details` ADD `in_trash` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `email_details` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `email_details` ADD `returned_from` integer;--> statement-breakpoint
CREATE INDEX `email_details_snoozed_until` ON `email_details` (`snoozed_until`);