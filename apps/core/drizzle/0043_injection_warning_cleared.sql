ALTER TABLE `injection_warnings` ADD `cleared_at` integer;--> statement-breakpoint
ALTER TABLE `injection_warnings` ADD `clear_entry_id` integer REFERENCES activity(id);