CREATE TABLE `challenger_diagnoses` (
	`id` text PRIMARY KEY NOT NULL,
	`challenger_prediction_id` text NOT NULL,
	`champion_prediction_id` text NOT NULL,
	`created_at` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text NOT NULL,
	`facts_json` text,
	`model_signals_json` text,
	`hypotheses_json` text,
	`tags_json` text,
	`research_hypothesis` text,
	`evidence_references_json` text,
	`confidence` real,
	`error_code` text,
	`direct_model_control_allowed` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_challenger_diagnosis_prediction` ON `challenger_diagnoses` (`challenger_prediction_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_challenger_diagnosis_status` ON `challenger_diagnoses` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `challenger_predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`champion_prediction_id` text NOT NULL,
	`feature_snapshot_id` text NOT NULL,
	`feature_snapshot_hash` text NOT NULL,
	`feature_json` text NOT NULL,
	`feature_status_json` text NOT NULL,
	`evidence_json` text NOT NULL,
	`frozen_at` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`champion_model_version` text NOT NULL,
	`champion_probability` real NOT NULL,
	`challenger_model_id` text NOT NULL,
	`dataset_version` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`challenger_probability` real NOT NULL,
	`probability_delta` real NOT NULL,
	`data_quality_state` text NOT NULL,
	`record_kind` text NOT NULL,
	`eligible` integer NOT NULL,
	`status` text NOT NULL,
	`actual_winner` text,
	`resolved_at` text,
	`champion_brier` real,
	`challenger_brier` real,
	`champion_log_loss` real,
	`challenger_log_loss` real,
	`champion_correct` integer,
	`challenger_correct` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `challenger_predictions_fixture_id_unique` ON `challenger_predictions` (`fixture_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `challenger_predictions_champion_prediction_id_unique` ON `challenger_predictions` (`champion_prediction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `challenger_predictions_feature_snapshot_id_unique` ON `challenger_predictions` (`feature_snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_challenger_status` ON `challenger_predictions` (`status`,`eligible`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_challenger_model` ON `challenger_predictions` (`challenger_model_id`,`status`);