import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const predictions = sqliteTable(
  'predictions',
  {
    id: text('id').primaryKey(), source: text('source').notNull(), modelVersion: text('model_version').notNull(),
    lockedAt: text('locked_at').notNull(), scheduledAt: text('scheduled_at').notNull(), event: text('event').notNull(),
    region: text('region').notNull(), patch: text('patch'), seriesFormat: text('series_format').notNull(),
    teamA: text('team_a').notNull(), teamB: text('team_b').notNull(), teamAProbability: real('team_a_probability').notNull(),
    predictedScore: text('predicted_score').notNull(), status: text('status').notNull(), actualWinner: text('actual_winner'),
    actualScore: text('actual_score'), resolvedAt: text('resolved_at'), dataCutoffAt: text('data_cutoff_at').notNull(),
    factorSnapshotJson: text('factor_snapshot_json').notNull(), mapProbabilitiesJson: text('map_probabilities_json').notNull(),
    scoreDistributionJson: text('score_distribution_json').notNull(), evidenceJson: text('evidence_json').notNull(),
    resultEvidenceVersion: text('result_evidence_version'), resultEvidenceJson: text('result_evidence_json'),
    scorecardVersion: text('scorecard_version'), scorecardJson: text('scorecard_json'), lastSyncRunId: text('last_sync_run_id'),
    createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_predictions_scheduled_at').on(table.scheduledAt),
    index('idx_predictions_status_scheduled').on(table.status, table.scheduledAt),
    index('idx_predictions_region_scheduled').on(table.region, table.scheduledAt),
  ],
);

export const aiAnalyses = sqliteTable(
  'ai_analyses',
  {
    id: text('id').primaryKey(), predictionId: text('prediction_id').notNull(), stage: text('stage').notNull(),
    provider: text('provider').notNull(), modelId: text('model_id').notNull(), promptVersion: text('prompt_version').notNull(),
    status: text('status').notNull(), outputJson: text('output_json'), errorCode: text('error_code'),
    directPromotionAllowed: integer('direct_promotion_allowed', { mode: 'boolean' }).notNull(), createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_ai_analyses_prediction_stage').on(table.predictionId, table.stage), index('idx_ai_analyses_created_at').on(table.createdAt)],
);

export const modelVersions = sqliteTable(
  'model_versions',
  {
    version: text('version').primaryKey(), role: text('role').notNull(), status: text('status').notNull(),
    parentVersion: text('parent_version'), trainingCutoff: text('training_cutoff'), minimumSampleGate: integer('minimum_sample_gate').notNull(),
    observedSamples: integer('observed_samples').notNull(), metricsJson: text('metrics_json').notNull(),
    constraintsJson: text('constraints_json').notNull(), createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_model_versions_role_status').on(table.role, table.status)],
);

export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(), runType: text('run_type').notNull(), status: text('status').notNull(),
    startedAt: text('started_at').notNull(), completedAt: text('completed_at'), countersJson: text('counters_json').notNull(),
    errorCode: text('error_code'),
  },
  (table) => [index('idx_automation_runs_started_at').on(table.startedAt)],
);

export const dataState = sqliteTable('data_state', {
  key: text('key').primaryKey(), valueJson: text('value_json').notNull(), updatedAt: text('updated_at').notNull(),
});

export const challengerPredictions = sqliteTable(
  'challenger_predictions',
  {
    id: text('id').primaryKey(), fixtureId: text('fixture_id').notNull().unique(), championPredictionId: text('champion_prediction_id').notNull().unique(),
    featureSnapshotId: text('feature_snapshot_id').notNull().unique(), featureSnapshotHash: text('feature_snapshot_hash').notNull(),
    featureJson: text('feature_json').notNull(), featureStatusJson: text('feature_status_json').notNull(), evidenceJson: text('evidence_json').notNull(),
    frozenAt: text('frozen_at').notNull(), scheduledAt: text('scheduled_at').notNull(), championModelVersion: text('champion_model_version').notNull(),
    championProbability: real('champion_probability').notNull(), challengerModelId: text('challenger_model_id').notNull(), datasetVersion: text('dataset_version').notNull(),
    artifactHash: text('artifact_hash').notNull(), challengerProbability: real('challenger_probability').notNull(), probabilityDelta: real('probability_delta').notNull(),
    dataQualityState: text('data_quality_state').notNull(), recordKind: text('record_kind').notNull(), eligible: integer('eligible', { mode: 'boolean' }).notNull(),
    status: text('status').notNull(), actualWinner: text('actual_winner'), resolvedAt: text('resolved_at'), championBrier: real('champion_brier'),
    challengerBrier: real('challenger_brier'), championLogLoss: real('champion_log_loss'), challengerLogLoss: real('challenger_log_loss'),
    championCorrect: integer('champion_correct', { mode: 'boolean' }), challengerCorrect: integer('challenger_correct', { mode: 'boolean' }),
    lastSyncRunId: text('last_sync_run_id'),
    createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_challenger_status').on(table.status, table.eligible, table.scheduledAt), index('idx_challenger_model').on(table.challengerModelId, table.status)],
);

export const challengerDiagnoses = sqliteTable(
  'challenger_diagnoses',
  {
    id: text('id').primaryKey(), challengerPredictionId: text('challenger_prediction_id').notNull(), championPredictionId: text('champion_prediction_id').notNull(),
    createdAt: text('created_at').notNull(), provider: text('provider').notNull(), modelId: text('model_id').notNull(), promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(), status: text('status').notNull(), resultJson: text('result_json').notNull(), factsJson: text('facts_json'),
    modelSignalsJson: text('model_signals_json'), hypothesesJson: text('hypotheses_json'), tagsJson: text('tags_json'), researchHypothesis: text('research_hypothesis'),
    evidenceReferencesJson: text('evidence_references_json'), confidence: real('confidence'), errorCode: text('error_code'),
    directModelControlAllowed: integer('direct_model_control_allowed', { mode: 'boolean' }).notNull(),
  },
  (table) => [index('idx_challenger_diagnosis_prediction').on(table.challengerPredictionId, table.createdAt), index('idx_challenger_diagnosis_status').on(table.status, table.createdAt)],
);

export const publicSyncRuns = sqliteTable(
  'public_sync_runs',
  {
    id: text('id').primaryKey(), runnerRunId: text('runner_run_id'), status: text('status').notNull(),
    startedAt: text('started_at').notNull(), completedAt: text('completed_at'), countersJson: text('counters_json').notNull(),
    failuresJson: text('failures_json').notNull(), errorCode: text('error_code'),
  },
  (table) => [index('idx_public_sync_runs_started_at').on(table.startedAt), index('idx_public_sync_runs_status').on(table.status, table.startedAt)],
);

export const aiAnalysisJobs = sqliteTable(
  'ai_analysis_jobs',
  {
    id: text('id').primaryKey(), logicalKey: text('logical_key').notNull(), predictionId: text('prediction_id').notNull(),
    stage: text('stage').notNull(), provider: text('provider').notNull(), modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(), schemaVersion: text('schema_version').notNull(), status: text('status').notNull(),
    retryPolicyVersion: text('retry_policy_version').notNull(), attemptCount: integer('attempt_count').notNull(),
    requestStartedAt: text('request_started_at'), requestCompletedAt: text('request_completed_at'), latencyMs: integer('latency_ms'),
    httpStatus: integer('http_status'), errorStage: text('error_stage'), errorCode: text('error_code'), errorMessage: text('error_message'),
    inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'), payloadBytes: integer('payload_bytes'),
    lastRetryAt: text('last_retry_at'), nextRetryAt: text('next_retry_at'), lockToken: text('lock_token'),
    rawEvidenceHash: text('raw_evidence_hash').notNull(), analysisPacketHash: text('analysis_packet_hash').notNull(),
    evidenceGrade: text('evidence_grade').notNull(), analysisPacketJson: text('analysis_packet_json').notNull(),
    outputAnalysisId: text('output_analysis_id'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_ai_analysis_jobs_logical_key').on(table.logicalKey),
    index('idx_ai_analysis_jobs_due').on(table.status, table.nextRetryAt),
    index('idx_ai_analysis_jobs_prediction').on(table.predictionId, table.stage, table.createdAt),
  ],
);

export const aiProviderAttempts = sqliteTable(
  'ai_provider_attempts',
  {
    id: text('id').primaryKey(), jobId: text('job_id').notNull(), attemptNo: integer('attempt_no').notNull(),
    provider: text('provider').notNull(), modelId: text('model_id').notNull(), status: text('status').notNull(),
    requestStartedAt: text('request_started_at').notNull(), requestCompletedAt: text('request_completed_at').notNull(),
    latencyMs: integer('latency_ms').notNull(), httpStatus: integer('http_status'), errorStage: text('error_stage'),
    errorCode: text('error_code'), errorMessage: text('error_message'), inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'), payloadBytes: integer('payload_bytes').notNull(), createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_ai_provider_attempt_job_no').on(table.jobId, table.attemptNo),
    index('idx_ai_provider_attempts_started').on(table.requestStartedAt),
    index('idx_ai_provider_attempts_status').on(table.status, table.requestStartedAt),
  ],
);

export const researchHypotheses = sqliteTable(
  'research_hypotheses',
  {
    id: text('id').primaryKey(), predictionId: text('prediction_id').notNull(), sourceJobId: text('source_job_id').notNull(),
    hypothesisHash: text('hypothesis_hash').notNull(), tag: text('tag').notNull(), hypothesis: text('hypothesis').notNull(),
    status: text('status').notNull(), evidenceReferencesJson: text('evidence_references_json').notNull(),
    confidence: real('confidence'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_research_hypothesis_job_hash').on(table.sourceJobId, table.hypothesisHash),
    index('idx_research_hypotheses_status').on(table.status, table.createdAt),
    index('idx_research_hypotheses_tag').on(table.tag, table.createdAt),
  ],
);

export const resultEvidenceRevisions = sqliteTable(
  'result_evidence_revisions',
  {
    id: text('id').primaryKey(), predictionId: text('prediction_id').notNull(), revisionNo: integer('revision_no').notNull(),
    reason: text('reason').notNull(), previousWinner: text('previous_winner').notNull(), previousScore: text('previous_score').notNull(),
    previousResolvedAt: text('previous_resolved_at').notNull(), previousResultEvidenceJson: text('previous_result_evidence_json').notNull(),
    previousScorecardJson: text('previous_scorecard_json').notNull(), previousEvidenceHash: text('previous_evidence_hash').notNull(),
    correctedWinner: text('corrected_winner').notNull(), correctedScore: text('corrected_score').notNull(),
    correctedResolvedAt: text('corrected_resolved_at').notNull(), correctedResultEvidenceJson: text('corrected_result_evidence_json').notNull(),
    correctedScorecardJson: text('corrected_scorecard_json').notNull(), correctedEvidenceHash: text('corrected_evidence_hash').notNull(),
    sourceUrl: text('source_url'), createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_result_evidence_revision').on(table.predictionId, table.revisionNo),
    index('idx_result_evidence_revisions_prediction').on(table.predictionId, table.createdAt),
  ],
);
