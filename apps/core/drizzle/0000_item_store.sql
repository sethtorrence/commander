CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`actor_ref` text,
	`action` text NOT NULL,
	`item_id` text NOT NULL,
	`other_item_id` text,
	`why` text,
	`caused_by_item_id` text,
	`caused_by_entry_id` integer,
	`undoes` integer,
	`before` text,
	`after` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`other_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`caused_by_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`caused_by_entry_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`undoes`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_item` ON `activity` (`item_id`);--> statement-breakpoint
CREATE INDEX `activity_other_item` ON `activity` (`other_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_undoes` ON `activity` (`undoes`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source` text,
	`account` text,
	`external_id` text,
	`title` text NOT NULL,
	`people` text NOT NULL,
	`project_id` text,
	`filed_by` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_identity` ON `items` (`source`,`account`,`external_id`);--> statement-breakpoint
CREATE INDEX `items_project` ON `items` (`project_id`);--> statement-breakpoint
CREATE INDEX `items_kind` ON `items` (`kind`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_item_id` text NOT NULL,
	`type` text NOT NULL,
	`to_item_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_identity` ON `links` (`from_item_id`,`type`,`to_item_id`);--> statement-breakpoint
CREATE INDEX `links_backlinks` ON `links` (`to_item_id`);--> statement-breakpoint
CREATE TABLE `todo_details` (
	`item_id` text PRIMARY KEY NOT NULL,
	`due_on` text,
	`backed_by` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`backed_by`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
