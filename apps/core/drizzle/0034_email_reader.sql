CREATE TABLE `email_image_settings` (
	`account` text PRIMARY KEY NOT NULL,
	`ask_first` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_image_trust` (
	`account` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`account`, `kind`, `value`)
);
