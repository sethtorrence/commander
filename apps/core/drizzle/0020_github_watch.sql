CREATE TABLE `github_watch` (
	`account` text PRIMARY KEY NOT NULL,
	`watch` text,
	`from_default` integer DEFAULT false NOT NULL,
	`access` text,
	`seen` text DEFAULT '[]' NOT NULL,
	`added_orgs` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
