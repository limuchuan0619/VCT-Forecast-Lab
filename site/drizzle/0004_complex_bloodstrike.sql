CREATE TABLE `ai_analysis_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`logical_key` text NOT NULL,
	`prediction_id` text NOT NULL,
	`stage` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`status` text NOT NULL,
	`retry_policy_version` text NOT NULL,
	`attempt_count` integer NOT NULL,
	`request_started_at` text,
	`request_completed_at` text,
	`latency_ms` integer,
	`http_status` integer,
	`error_stage` text,
	`error_code` text,
	`error_message` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`payload_bytes` integer,
	`last_retry_at` text,
	`next_retry_at` text,
	`lock_token` text,
	`raw_evidence_hash` text NOT NULL,
	`analysis_packet_hash` text NOT NULL,
	`evidence_grade` text NOT NULL,
	`analysis_packet_json` text NOT NULL,
	`output_analysis_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_analysis_jobs_logical_key` ON `ai_analysis_jobs` (`logical_key`);--> statement-breakpoint
CREATE INDEX `idx_ai_analysis_jobs_due` ON `ai_analysis_jobs` (`status`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_analysis_jobs_prediction` ON `ai_analysis_jobs` (`prediction_id`,`stage`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_provider_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`status` text NOT NULL,
	`request_started_at` text NOT NULL,
	`request_completed_at` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`http_status` integer,
	`error_stage` text,
	`error_code` text,
	`error_message` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`payload_bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_provider_attempt_job_no` ON `ai_provider_attempts` (`job_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `idx_ai_provider_attempts_started` ON `ai_provider_attempts` (`request_started_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_provider_attempts_status` ON `ai_provider_attempts` (`status`,`request_started_at`);--> statement-breakpoint
CREATE TABLE `research_hypotheses` (
	`id` text PRIMARY KEY NOT NULL,
	`prediction_id` text NOT NULL,
	`source_job_id` text NOT NULL,
	`hypothesis_hash` text NOT NULL,
	`tag` text NOT NULL,
	`hypothesis` text NOT NULL,
	`status` text NOT NULL,
	`evidence_references_json` text NOT NULL,
	`confidence` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_research_hypothesis_job_hash` ON `research_hypotheses` (`source_job_id`,`hypothesis_hash`);--> statement-breakpoint
CREATE INDEX `idx_research_hypotheses_status` ON `research_hypotheses` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_research_hypotheses_tag` ON `research_hypotheses` (`tag`,`created_at`);