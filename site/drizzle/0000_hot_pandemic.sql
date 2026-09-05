CREATE TABLE `ai_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`prediction_id` text NOT NULL,
	`stage` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`output_json` text,
	`error_code` text,
	`direct_promotion_allowed` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_analyses_prediction_stage` ON `ai_analyses` (`prediction_id`,`stage`);--> statement-breakpoint
CREATE INDEX `idx_ai_analyses_created_at` ON `ai_analyses` (`created_at`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_type` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`counters_json` text NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `idx_automation_runs_started_at` ON `automation_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `data_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_versions` (
	`version` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`parent_version` text,
	`training_cutoff` text,
	`minimum_sample_gate` integer NOT NULL,
	`observed_samples` integer NOT NULL,
	`metrics_json` text NOT NULL,
	`constraints_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_model_versions_role_status` ON `model_versions` (`role`,`status`);--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`model_version` text NOT NULL,
	`locked_at` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`event` text NOT NULL,
	`region` text NOT NULL,
	`patch` text,
	`series_format` text NOT NULL,
	`team_a` text NOT NULL,
	`team_b` text NOT NULL,
	`team_a_probability` real NOT NULL,
	`predicted_score` text NOT NULL,
	`status` text NOT NULL,
	`actual_winner` text,
	`actual_score` text,
	`resolved_at` text,
	`data_cutoff_at` text NOT NULL,
	`factor_snapshot_json` text NOT NULL,
	`map_probabilities_json` text NOT NULL,
	`score_distribution_json` text NOT NULL,
	`evidence_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_predictions_scheduled_at` ON `predictions` (`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_predictions_status_scheduled` ON `predictions` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_predictions_region_scheduled` ON `predictions` (`region`,`scheduled_at`);