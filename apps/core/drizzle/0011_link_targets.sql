ALTER TABLE `activity` ADD `other_project_id` text REFERENCES projects(id);--> statement-breakpoint
ALTER TABLE `links` ADD `target_type` text DEFAULT 'item' NOT NULL;--> statement-breakpoint
ALTER TABLE `links` ADD `to_project_id` text REFERENCES projects(id);--> statement-breakpoint
CREATE UNIQUE INDEX `links_project_identity` ON `links` (`from_item_id`,`type`,`to_project_id`);--> statement-breakpoint
CREATE INDEX `links_project_backlinks` ON `links` (`to_project_id`);