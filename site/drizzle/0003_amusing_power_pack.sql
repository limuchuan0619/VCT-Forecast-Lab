CREATE TABLE `public_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`runner_run_id` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`counters_json` text NOT NULL,
	`failures_json` text NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `idx_public_sync_runs_started_at` ON `public_sync_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_public_sync_runs_status` ON `public_sync_runs` (`status`,`started_at`);--> statement-breakpoint
ALTER TABLE `challenger_predictions` ADD `last_sync_run_id` text;--> statement-breakpoint
ALTER TABLE `predictions` ADD `result_evidence_version` text;--> statement-breakpoint
ALTER TABLE `predictions` ADD `result_evidence_json` text;--> statement-breakpoint
ALTER TABLE `predictions` ADD `scorecard_version` text;--> statement-breakpoint
ALTER TABLE `predictions` ADD `scorecard_json` text;--> statement-breakpoint
ALTER TABLE `predictions` ADD `last_sync_run_id` text;