CREATE TABLE `result_evidence_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`prediction_id` text NOT NULL,
	`revision_no` integer NOT NULL,
	`reason` text NOT NULL,
	`previous_winner` text NOT NULL,
	`previous_score` text NOT NULL,
	`previous_resolved_at` text NOT NULL,
	`previous_result_evidence_json` text NOT NULL,
	`previous_scorecard_json` text NOT NULL,
	`previous_evidence_hash` text NOT NULL,
	`corrected_winner` text NOT NULL,
	`corrected_score` text NOT NULL,
	`corrected_resolved_at` text NOT NULL,
	`corrected_result_evidence_json` text NOT NULL,
	`corrected_scorecard_json` text NOT NULL,
	`corrected_evidence_hash` text NOT NULL,
	`source_url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_result_evidence_revision` ON `result_evidence_revisions` (`prediction_id`,`revision_no`);--> statement-breakpoint
CREATE INDEX `idx_result_evidence_revisions_prediction` ON `result_evidence_revisions` (`prediction_id`,`created_at`);