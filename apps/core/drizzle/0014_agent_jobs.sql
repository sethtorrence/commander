CREATE TABLE `agent_jobs` (
	`job` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cursor` integer,
	`last_run_at` integer,
	`last_outcome` text,
	`last_problem` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`retry_at` integer
);
--> statement-breakpoint
CREATE TABLE `agent_seen` (
	`job` text NOT NULL,
	`item_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`proposal_id` integer,
	`at` integer NOT NULL,
	PRIMARY KEY(`job`, `item_id`, `fingerprint`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE no action
);
