export type FactorContribution = {
  key: string; rank: number; label: string; detail: string; probabilityPoints: number; absoluteShare: number;
};

export type MapProbability = { map: string; teamAProbability: number; teamBProbability: number; samples?: [number, number] };

export type PredictionSnapshot = {
  id: string; source: string; modelVersion: string; lockedAt: string; scheduledAt: string; event: string; region: string;
  patch?: string | null; seriesFormat: 'bo3' | 'bo5'; teamA: string; teamB: string; teamAProbability: number;
  predictedScore: string; status: 'locked' | 'resolved'; actualWinner?: string | null; actualScore?: string | null;
  resolvedAt?: string | null; dataCutoffAt: string; factors: FactorContribution[]; maps: MapProbability[];
  scoreDistribution: Record<string, number>; evidence: { sourceUrl?: string; sourceLabel: string; patchProvenance: string; qualityGate: string; sourceSnapshotAt?: string; temporalNote?: string };
};

export type AiFactor = {
  factor: string; direction: 'team_a' | 'team_b' | 'neutral'; importance: number; evidence_ids: string[];
  claim?: string;
};

export type AiHypothesis = {
  hypothesis: string; target_feature: string; expected_effect?: string; validation_plan: string; no_direct_change?: true;
};

export type PrematchAiAnalysis = {
  stage: 'prematch'; ai_probability_team_a: number; predicted_score: string; summary: string; key_factors: AiFactor[];
  risk_flags: string[]; upset_conditions: string[]; model_disagreement: string; optimization_hypotheses: string[];
  evidence_grade?: 'high' | 'medium' | 'low';
  official_model_reading?: { favored_team: string; probability_gap_pp: number; strongest_support: string; strongest_counterweight: string };
  team_a_win_conditions?: string[]; team_b_win_conditions?: string[];
  map_analysis?: Array<{ map: string; team_a_probability: number; interpretation: string; sample_warning: string; evidence_ids: string[] }>;
  uncertainty?: { missing_data: string[]; low_sample_signals: string[]; invalidation_triggers: string[] };
  structured_hypotheses?: AiHypothesis[];
  direct_promotion_allowed: false;
};

export type PostmatchAiReview = {
  stage: 'postmatch'; summary: string; result_classification: 'normal_variance' | 'calibration_issue' | 'data_issue' | 'candidate_model_issue';
  evidence: string[]; error_drivers: string[]; candidate_hypotheses: string[]; retraining_recommendation: 'none' | 'shadow_experiment';
  outcome_evaluation?: { winner_correct: boolean; score_correct: boolean; probability_was_reasonable: boolean; calibration_comment: string };
  validated_factors?: string[]; invalidated_factors?: string[];
  map_review?: Array<{ map: string; pre_match_reading: string; actual_evidence: string; conclusion: string }>;
  variance_vs_model_error?: { verdict: 'variance' | 'model_error' | 'mixed' | 'insufficient_evidence'; explanation: string };
  structured_hypotheses?: AiHypothesis[];
  direct_promotion_allowed: false;
};

export type ProspectiveLearningState = {
  mode: 'prospective_gold'; startedAt: string | null; snapshots: number; fixtures: number;
  ready: number; blocked: number; labeled: number; pending: number; trainingEligible: number; trainingGate: number;
};

export type ChallengerPrediction = {
  id: string; fixtureId: string; championPredictionId: string; featureSnapshotId: string; featureSnapshotHash: string;
  features: Record<string, number | null>; featureStatus: Record<string, 'observed' | 'imputed_team_mean' | 'feature_unavailable'>;
  evidence: Record<string, unknown>; frozenAt: string; scheduledAt: string; championModelVersion: string; championProbability: number;
  challengerModelId: string; datasetVersion: string; artifactHash: string; challengerProbability: number; probabilityDelta: number;
  dataQualityState: string; recordKind: 'real_prospective' | 'isolated_test'; eligible: boolean; status: 'locked' | 'resolved';
  actualWinner?: string | null; resolvedAt?: string | null; championBrier?: number | null; challengerBrier?: number | null;
  championLogLoss?: number | null; challengerLogLoss?: number | null; championCorrect?: boolean | null; challengerCorrect?: boolean | null;
};

export type DiagnosisTag = 'rating_lag' | 'recent_form' | 'roster_change' | 'map_matchup' | 'player_form' | 'cross_region' | 'missing_context' | 'calibration' | 'unexplained';

export type PostmatchModelDiagnosis = {
  stage: 'postmatch_model_diagnosis';
  prediction_summary: { champion_probability_team_a: number; c1_probability_team_a: number; actual_winner: string };
  model_agreement: { status: 'models_agreed' | 'models_disagreed'; probability_gap: number };
  facts: Array<{ claim: string; evidence_ids: string[] }>;
  model_signals: Array<{ claim: string; evidence_ids: string[] }>;
  hypotheses: Array<{ hypothesis: string; tag: DiagnosisTag; evidence_ids: string[]; confidence: number }>;
  diagnostic_tags: DiagnosisTag[]; research_hypothesis: string | null; confidence: number;
  direct_probability_change_allowed: false; direct_training_allowed: false; direct_promotion_allowed: false;
};

export type PredictionRecord = PredictionSnapshot & {
  prematchAiStatus?: string | null;
  prematchAnalysis?: PrematchAiAnalysis | null;
  postmatchAiStatus?: string | null;
  postmatchReview?: PostmatchAiReview | null;
};

export type AutomationSchedule = {
  intervalSeconds: number;
  horizonHours: number;
  executionEnvironment: 'cloud';
};

export type AutomationHealth = {
  status: 'healthy' | 'stale' | 'degraded' | 'waiting';
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
};

export type PublicOverview = {
  prediction: PredictionSnapshot; data: { matches: number; teams: number; predictions: number; regions: number; cutoffAt: string };
  ai: { configured: boolean; status: 'ready' | 'waiting_for_key' | 'available' | 'failed'; modelId: string; analysis?: PrematchAiAnalysis | null };
  governance: { champion: string; globalWeightsFrozen: boolean; observedSamples: number; minimumSampleGate: number; promotionEnabled: boolean };
  automation: AutomationHealth;
  learning: ProspectiveLearningState;
};
