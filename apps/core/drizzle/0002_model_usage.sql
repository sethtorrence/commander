CREATE TABLE `model_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`job` text NOT NULL,
	`tier` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`cost_usd` real,
	`outcome` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_calls_at` ON `model_calls` (`at`);--> statement-breakpoint
CREATE TABLE `model_cap_warnings` (
	`month` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`spent_usd` real NOT NULL,
	`cap_usd` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL
);
