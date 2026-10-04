CREATE TABLE `dashboard_clears` (
	`item_id` text PRIMARY KEY NOT NULL,
	`band` text NOT NULL,
	`at` integer NOT NULL,
	`fingerprint` text
);
--> statement-breakpoint
CREATE TABLE `dashboard_ranked` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dashboard_rankings` (
	`item_id` text PRIMARY KEY NOT NULL,
	`band` text NOT NULL,
	`rank` integer NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL
);
