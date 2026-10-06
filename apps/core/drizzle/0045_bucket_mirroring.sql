CREATE TABLE `bucket_mirror_labels` (
	`account` text NOT NULL,
	`bucket_id` text NOT NULL,
	`name` text NOT NULL,
	`ready` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`account`, `bucket_id`)
);
--> statement-breakpoint
CREATE TABLE `bucket_mirroring` (
	`account` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`enabled` integer NOT NULL,
	`removing` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `buckets` ADD `skip_inbox` integer DEFAULT false NOT NULL;