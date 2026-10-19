export type FactorContribution = {
  key: string;
  rank: number;
  label: string;
  detail: string;
  probabilityPoints: number;
  absoluteShare: number;
};

export type MapProbability = {
  map: string;
  teamAProbability: number;
  teamBProbability: number;
  teamAMapRating?: number;
  teamBMapRating?: number;
  samples?: [number, number];
};

export type ResultEvidenceEnvelope = {
  schemaVersion: 'v1.4c-r1-result-evidence-v1';
  source: {
    sourceId: string;
    sourceUrl?: string | null;
    sourceMatchId?: string | null;
    capturedAt: string;
  };
  series: {
    actualWinner: string;
    actualScore: string;
    scheduledAt: string;
    playedAt?: string | null;
    seriesFormat: 'bo3' | 'bo5';
  };
  maps: Array<{
    order: number;
    map: string;
    teamAScore: number;
    teamBScore: number;
    winner: string;
    sourceUrl?: string | null;
    missingFields: string[];
  }>;
  playerStats: Array<Record<string, string | number | null>> | null;
  missing: {
    maps: boolean;
    playerStats: boolean;
    attackDefense: boolean;
    veto: boolean;
  };
};

export type PostmatchScorecard = {
  schemaVersion: 'v1.4c-r1-scorecard-v1';
  thresholdVersion: 'v1.4c-r1-surprise-thresholds-v1';
  predictedWinner: string;
  actualWinner: string;
  winnerCorrect: boolean;
  predictedScore: string;
  actualScore: string;
  exactScoreCorrect: boolean;
  actualWinnerProbability: number;
  actualScoreProbability: number | null;
  brierScore: number;
  logLoss: number;
  winnerSurprisal: number;
  scorelineSurprisal: number | null;
  directionReversal: boolean;
  surpriseLevel: 'low' | 'moderate' | 'high' | 'very_high';
};

export type PredictionSnapshot = {
  id: string;
  source: string;
  modelVersion: string;
  lockedAt: string;
  scheduledAt: string;
  event: string;
  region: string;
  patch?: string | null;
  seriesFormat: 'bo3' | 'bo5';
  teamA: string;
  teamB: string;
  teamAProbability: number;
  predictedScore: string;
  status: 'locked' | 'resolved';
  actualWinner?: string | null;
  actualScore?: string | null;
  resolvedAt?: string | null;
  dataCutoffAt: string;
  factors: FactorContribution[];
  maps: MapProbability[];
  scoreDistribution: Record<string, number>;
  evidence: {
    sourceUrl?: string;
    sourceLabel: string;
    patchProvenance: string;
    qualityGate: string;
    sourceSnapshotAt?: string;
    temporalNote?: string;
  };
  resultEvidence?: ResultEvidenceEnvelope | null;
  scorecard?: PostmatchScorecard | null;
};

export type AiFactor = {
  factor: string;
  direction: 'team_a' | 'team_b' | 'neutral';
  importance: number;
  evidence_ids: string[];
  claim?: string;
};

export type AiHypothesis = {
  hypothesis: string;
  target_feature: string;
  expected_effect?: string;
  validation_plan: string;
  no_direct_change?: true;
};

export type PrematchAiAnalysis = {
  stage: 'prematch';
  ai_probability_team_a: number;
  predicted_score: string;
  summary: string;
  key_factors: AiFactor[];
  risk_flags: string[];
  upset_conditions: string[];
  model_disagreement: string;
  optimization_hypotheses: string[];
  evidence_grade?: 'high' | 'medium' | 'low';
  official_model_reading?: {
    favored_team: string;
    probability_gap_pp: number;
    strongest_support: string;
    strongest_counterweight: string;
  };
  team_a_win_conditions?: string[];
  team_b_win_conditions?: string[];
  map_analysis?: Array<{
    map: string;
    team_a_probability: number;
    interpretation: string;
    sample_warning: string;
    evidence_ids: string[];
  }>;
  uncertainty?: {
    missing_data: string[];
    low_sample_signals: string[];
    invalidation_triggers: string[];
  };
  structured_hypotheses?: AiHypothesis[];
  direct_promotion_allowed: false;
};

export type PostmatchAiReview = {
  stage: 'postmatch';
  reader_review?: import('./reader-analysis').ReaderReview;
  summary?: string;
  team_reviews?: Array<{
    team: string;
    outcome: 'won' | 'lost';
    strengths: Array<{ claim: string; evidence_ids: string[] }>;
    weaknesses: Array<{ claim: string; evidence_ids: string[] }>;
    possible_explanation?: { claim: string; evidence_ids: string[] } | null;
  }>;
  facts?: Array<{ claim: string; evidence_ids: string[] }>;
  model_signals?: Array<{ claim: string; evidence_ids: string[] }>;
  hypotheses?: Array<{
    hypothesis: string;
    evidence_ids: string[];
    confidence: number;
  }>;
  missing_evidence?: string[];
  research_hypotheses?: AiHypothesis[];
  deterministic_scorecard_owned_by_system?: true;
  result_classification?:
    | 'normal_variance'
    | 'calibration_issue'
    | 'data_issue'
    | 'candidate_model_issue';
  evidence?: string[];
  error_drivers?: string[];
  candidate_hypotheses?: string[];
  retraining_recommendation?: 'none' | 'shadow_experiment';
  outcome_evaluation?: {
    winner_correct: boolean;
    score_correct: boolean;
    probability_was_reasonable: boolean;
    calibration_comment: string;
  };
  validated_factors?: string[];
  invalidated_factors?: string[];
  map_review?: Array<{
    map: string;
    pre_match_reading?: string;
    actual_evidence: string;
    conclusion?: string;
    hypothesis?: string;
    evidence_ids?: string[];
  }>;
  variance_vs_model_error?: {
    verdict: 'variance' | 'model_error' | 'mixed' | 'insufficient_evidence';
    explanation: string;
  };
  structured_hypotheses?: AiHypothesis[];
  direct_probability_change_allowed?: false;
  direct_training_allowed?: false;
  direct_promotion_allowed: false;
  one_line_summary?: string;
  what_happened?: Array<{ claim: string; evidence_ids: string[] }>;
  three_signals?: Array<{
    signal: string;
    relation: 'supported_result' | 'contradicted_result' | 'neutral';
    evidence_ids: string[];
  }>;
  map_reviews?: Array<{
    map: string;
    fact: string;
    model_signal: string;
    hypothesis: string;
    evidence_ids: string[];
  }>;
  player_outliers?: Array<{
    player: string;
    map: string;
    fact: string;
    hypothesis: string;
    evidence_ids: string[];
  }>;
  research_queue?: {
    hypothesis: string;
    tag: string;
    status: 'NEW';
    evidence_ids: string[];
    confidence: number;
  } | null;
};

export type AiAnalysisJobPublic = {
  id: string;
  predictionId: string;
  stage: 'prematch' | 'postmatch' | 'diagnosis';
  provider: string;
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  status:
    | 'PENDING'
    | 'RUNNING'
    | 'RETRYABLE_FAILED'
    | 'RETRY_SCHEDULED'
    | 'SUCCESS'
    | 'FINAL_FAILED';
  attemptCount: number;
  requestStartedAt: string | null;
  requestCompletedAt: string | null;
  latencyMs: number | null;
  httpStatus: number | null;
  errorStage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  payloadBytes: number | null;
  lastRetryAt: string | null;
  nextRetryAt: string | null;
  rawEvidenceHash: string;
  analysisPacketHash: string;
  evidenceGrade: 'A' | 'B' | 'C' | 'D';
  retryPolicyVersion: string;
};

export type ProspectiveLearningState = {
  mode: 'prospective_gold';
  startedAt: string | null;
  snapshots: number;
  fixtures: number;
  ready: number;
  blocked: number;
  labeled: number;
  pending: number;
  trainingEligible: number;
  trainingGate: number;
  snapshotObservations?: number;
  fixtureCoverage?: number;
};

export type ChallengerPrediction = {
  id: string;
  fixtureId: string;
  championPredictionId: string;
  featureSnapshotId: string;
  featureSnapshotHash: string;
  features: Record<string, number | null>;
  featureStatus: Record<
    string,
    'observed' | 'imputed_team_mean' | 'feature_unavailable'
  >;
  evidence: Record<string, unknown>;
  frozenAt: string;
  scheduledAt: string;
  championModelVersion: string;
  championProbability: number;
  challengerModelId: string;
  datasetVersion: string;
  artifactHash: string;
  challengerProbability: number;
  probabilityDelta: number;
  dataQualityState: string;
  recordKind: 'real_prospective' | 'isolated_test';
  eligible: boolean;
  status: 'locked' | 'resolved';
  actualWinner?: string | null;
  resolvedAt?: string | null;
  championBrier?: number | null;
  challengerBrier?: number | null;
  championLogLoss?: number | null;
  challengerLogLoss?: number | null;
  championCorrect?: boolean | null;
  challengerCorrect?: boolean | null;
};

export type DiagnosisTag =
  | 'rating_lag'
  | 'recent_form'
  | 'roster_change'
  | 'map_matchup'
  | 'player_form'
  | 'cross_region'
  | 'missing_context'
  | 'calibration'
  | 'unexplained';

export type PostmatchModelDiagnosis = {
  stage: 'postmatch_model_diagnosis';
  prediction_summary: {
    champion_probability_team_a: number;
    c1_probability_team_a: number;
    actual_winner: string;
  };
  model_agreement: {
    status: 'models_agreed' | 'models_disagreed';
    probability_gap: number;
  };
  facts: Array<{ claim: string; evidence_ids: string[] }>;
  model_signals: Array<{ claim: string; evidence_ids: string[] }>;
  hypotheses: Array<{
    hypothesis: string;
    tag: DiagnosisTag;
    evidence_ids: string[];
    confidence: number;
  }>;
  diagnostic_tags: DiagnosisTag[];
  research_hypothesis: string | null;
  confidence: number;
  direct_probability_change_allowed: false;
  direct_training_allowed: false;
  direct_promotion_allowed: false;
};

export type PredictionRecord = PredictionSnapshot & {
  prematchAiCreatedAt?: string | null;
  prematchAiModelId?: string | null;
  challenger?: ChallengerPrediction | null;
  prematchAiStatus?: string | null;
  prematchAnalysis?: PrematchAiAnalysis | null;
  postmatchAiStatus?: string | null;
  postmatchReview?: PostmatchAiReview | null;
  postmatchJob?: AiAnalysisJobPublic | null;
  postmatchEvidence?: import('./ai-reliability').AnalysisPacket | null;
  resultCorrectionCount?: number;
};

export type AutomationSchedule = {
  intervalSeconds: number;
  horizonHours: number;
  executionEnvironment: 'cloud';
};

export type AutomationHealth = {
  status: 'healthy' | 'stale' | 'degraded' | 'failed' | 'waiting';
  lastRunStatus: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  nextExpectedAt: string | null;
  dataUpdatedAt: string | null;
  lastAiCompletedAt: string | null;
  intervalSeconds: number;
  horizonHours: number;
  pendingResults: number;
  pendingReviews: number;
  lastCounters: Record<string, unknown>;
  syncRunId?: string | null;
  syncStatus?: 'SUCCESS' | 'DEGRADED' | 'FAILED' | 'RUNNING' | null;
  lastSuccessfulSyncAt?: string | null;
  syncFailures?: Array<{ type: string; id: string; error: string }>;
};

export type ChallengerPublicState = {
  modelId: string;
  status: 'SHADOW';
  phase: 'ACCUMULATING' | 'PRELIMINARY' | 'EVALUATING' | 'GATE_READY';
  eligibleResolvedMatches: number;
  gate: 100;
  promotionStatus: 'EVALUATING' | 'GATE_READY';
  promotionEnabled: false;
  historicalEvaluationIncluded: false;
  metricIntegrity?: {
    status: string;
    schema_version?: string;
    checked_matches?: number;
    valid_matches?: number;
    invalid_matches?: number;
    repair_revisions?: number;
  };
  metrics?: Record<
    'champion' | 'logistic_c1',
    { brier: number; log_loss: number; accuracy: number; ece_10_bin: number }
  > | null;
};

export type PublicOverview = {
  prediction: PredictionSnapshot;
  data: {
    matches: number;
    teams: number;
    predictions: number;
    regions: number;
    cutoffAt: string;
  };
  dataMode: 'LIVE' | 'DEGRADED' | 'DEMO';
  dataModeReason?: string | null;
  ai: {
    configured: boolean;
    status: 'ready' | 'waiting_for_key' | 'available' | 'failed';
    modelId: string;
    analysis?: PrematchAiAnalysis | null;
  };
  governance: {
    champion: string;
    globalWeightsFrozen: boolean;
    observedSamples: number;
    minimumSampleGate: number;
    promotionEnabled: boolean;
  };
  automation: AutomationHealth;
  learning: ProspectiveLearningState;
  challenger: ChallengerPublicState | null;
  evaluationIntegrity?: import('./evaluation-integrity').EvaluationIntegrity;
  aiReliability?: {
    prematch: AiStageReliability;
    postmatch: AiStageReliability;
    diagnosis?: AiStageReliability;
    windowHours: 24;
  };
};

export type AiStageReliability = {
  health: 'HEALTHY' | 'DEGRADED' | 'FAILED';
  attempted: number;
  succeeded: number;
  retrying: number;
  failed: number;
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  provider429: number;
  provider5xx: number;
  timeouts: number;
  schemaFailures: number;
  orphanPredictions: number;
};
