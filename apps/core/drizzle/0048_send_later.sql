ALTER TABLE `email_compose` ADD `scheduled_at` integer;--> statement-breakpoint
ALTER TABLE `email_compose` ADD `held_by` text;--> statement-breakpoint
ALTER TABLE `email_compose` ADD `missed_at` integer;--> statement-breakpoint
CREATE INDEX `email_compose_scheduled_at` ON `email_compose` (`scheduled_at`);