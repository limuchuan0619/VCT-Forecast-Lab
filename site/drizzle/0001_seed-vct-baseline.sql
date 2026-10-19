-- Portfolio-only empty initialization. No production counts or match rows.
INSERT OR IGNORE INTO model_versions (
  version, role, status, parent_version, training_cutoff, minimum_sample_gate, observed_samples, metrics_json, constraints_json, created_at
) VALUES (
  'v1.0.0', 'champion', 'frozen', NULL, NULL, 100, 0,
  '{"accuracy":null,"brier_score":null,"log_loss":null,"evidence":"insufficient_real_locked_samples"}',
  '{"global_weights_frozen":true,"direct_llm_promotion":false,"minimum_overall_samples":100,"minimum_region_samples":20}',
  '2026-01-01T00:00:00.000Z'
);
--> statement-breakpoint
INSERT OR IGNORE INTO data_state (key, value_json, updated_at) VALUES
  ('coverage', '{"matches":0,"teams":0,"predictions":0,"regions":0,"source":"PORTFOLIO_EMPTY_NOT_PRODUCTION","years":[]}', '2026-01-01T00:00:00.000Z');
