PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_item_id` text NOT NULL,
	`type` text NOT NULL,
	`target_type` text DEFAULT 'item' NOT NULL,
	`to_item_id` text,
	`to_project_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "links_target" CHECK(("__new_links"."target_type" = 'item' AND "__new_links"."to_item_id" IS NOT NULL AND "__new_links"."to_project_id" IS NULL) OR ("__new_links"."target_type" = 'project' AND "__new_links"."type" = 'refers-to' AND "__new_links"."to_project_id" IS NOT NULL AND "__new_links"."to_item_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_links`("id", "from_item_id", "type", "target_type", "to_item_id", "to_project_id", "created_at") SELECT "id", "from_item_id", "type", "target_type", "to_item_id", "to_project_id", "created_at" FROM `links`;--> statement-breakpoint
DROP TABLE `links`;--> statement-breakpoint
ALTER TABLE `__new_links` RENAME TO `links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `links_identity` ON `links` (`from_item_id`,`type`,`to_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `links_project_identity` ON `links` (`from_item_id`,`type`,`to_project_id`);--> statement-breakpoint
CREATE INDEX `links_backlinks` ON `links` (`to_item_id`);--> statement-breakpoint
CREATE INDEX `links_project_backlinks` ON `links` (`to_project_id`);