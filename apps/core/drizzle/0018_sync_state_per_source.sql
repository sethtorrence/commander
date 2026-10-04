PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sync_state` (
	`account` text NOT NULL,
	`source` text NOT NULL,
	`cadence_minutes` integer,
	`cursor` text,
	`last_synced_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`problem` text,
	`last_full_sync_at` integer,
	`also_after_other_sources` integer,
	PRIMARY KEY(`account`, `source`)
);
--> statement-breakpoint
INSERT INTO `__new_sync_state`("account", "source", "cadence_minutes", "cursor", "last_synced_at", "failures", "retry_at", "problem", "last_full_sync_at", "also_after_other_sources") SELECT "account", "source", "cadence_minutes", "cursor", "last_synced_at", "failures", "retry_at", "problem", "last_full_sync_at", "also_after_other_sources" FROM `sync_state`;--> statement-breakpoint
DROP TABLE `sync_state`;--> statement-breakpoint
ALTER TABLE `__new_sync_state` RENAME TO `sync_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;