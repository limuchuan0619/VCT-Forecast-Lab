import { buildAnalysisPacket, canonicalJson } from './ai-reliability.ts';
import type { ChallengerPrediction, DiagnosisTag, PostmatchModelDiagnosis, PredictionSnapshot } from './vct-types.ts';

export const DIAGNOSIS_JOB_PROMPT_VERSION = 'vct-postmatch-model-diagnosis-v1.4c-r2.3';
export const DIAGNOSIS_JOB_SCHEMA_VERSION = 'v1.4c-r2.3-diagnosis-job-v1';
const tags: DiagnosisTag[] = ['rating_lag', 'recent_form', 'roster_change', 'map_matchup', 'player_form', 'cross_region', 'missing_context', 'calibration', 'unexplained'];

export function buildDiagnosisPacket(prediction: PredictionSnapshot, challenger: ChallengerPrediction) {
  if (prediction.status !== 'resolved' || !prediction.resultEvidence || !prediction.scorecard || challenger.status !== 'resolved') throw new Error('diagnosis_resolved_evidence_required');
  if (challenger.championPredictionId !== prediction.id || challenger.actualWinner !== prediction.actualWinner
    || Math.abs(challenger.championProbability - prediction.teamAProbability) > 1e-12
    || Date.parse(challenger.frozenAt) !== Date.parse(prediction.lockedAt)
    || !(Date.parse(challenger.frozenAt) < Date.parse(prediction.scheduledAt))) throw new Error('diagnosis_frozen_pair_conflict');
  const packet = buildAnalysisPacket(prediction);
  const featureEvidence = Object.entries(challenger.features).map(([feature, value]) => ({
    evidence_id: `c1_feature:${feature}`, feature, value, status: challenger.featureStatus[feature],
  }));
  const input = {
    stage: 'postmatch_model_diagnosis',
    evidence_boundary: {
      rule: 'FACT only from supplied evidence; MODEL SIGNAL only from frozen inputs/outputs; causal explanations are HYPOTHESIS, not facts.',
      direct_probability_change_allowed: false, direct_training_allowed: false, direct_promotion_allowed: false,
    },
    expected_summary: { champion_probability_team_a: prediction.teamAProbability, c1_probability_team_a: challenger.challengerProbability, actual_winner: prediction.actualWinner! },
    expected_agreement: {
      status: (prediction.teamAProbability >= .5) === (challenger.challengerProbability >= .5) ? 'models_agreed' : 'models_disagreed',
      probability_gap: Math.abs(challenger.challengerProbability - prediction.teamAProbability),
    },
    fact_evidence: [
      { evidence_id: 'fact:result', actual_winner: prediction.actualWinner, actual_score: prediction.actualScore, resolved_at: prediction.resolvedAt },
      { evidence_id: 'fact:freeze_order', champion_locked_at: prediction.lockedAt, c1_frozen_at: challenger.frozenAt, scheduled_at: prediction.scheduledAt },
      ...packet.maps.map((map) => ({ evidence_id: `fact:map:${map.order}`, map })),
      ...packet.playerOutliers.map((player, index) => ({ evidence_id: `fact:player_outlier:${index}`, player })),
    ],
    model_signal_evidence: [
      { evidence_id: 'model:champion', model: prediction.modelVersion, probability_team_a: prediction.teamAProbability, factors: prediction.factors },
      { evidence_id: 'system:scorecard', deterministic_scorecard: prediction.scorecard },
      { evidence_id: 'model:c1', model: challenger.challengerModelId, dataset_version: challenger.datasetVersion, artifact_hash: challenger.artifactHash, probability_team_a: challenger.challengerProbability },
      ...featureEvidence,
    ],
    teams: { team_a: prediction.teamA, team_b: prediction.teamB },
    missing_evidence: packet.missingEvidence,
  };
  const built = {
    schemaVersion: DIAGNOSIS_JOB_SCHEMA_VERSION, input, challenger,
    result: { actualWinner: prediction.actualWinner!, actualScore: prediction.actualScore! },
    evidenceGrade: packet.evidenceGrade,
  };
  if (new TextEncoder().encode(canonicalJson(built)).byteLength > 40_000) throw new Error('diagnosis_packet_context_limit');
  return built;
}

export type DiagnosisPacket = ReturnType<typeof buildDiagnosisPacket>;

export function validateModelDiagnosis(value: unknown, packet: DiagnosisPacket): asserts value is PostmatchModelDiagnosis {
  const output = value as PostmatchModelDiagnosis;
  if (!output || output.stage !== 'postmatch_model_diagnosis' || output.direct_probability_change_allowed !== false
    || output.direct_training_allowed !== false || output.direct_promotion_allowed !== false) throw new Error('diagnosis_schema_governance');
  const summary = output.prediction_summary;
  if (!summary || summary.actual_winner !== packet.result.actualWinner
    || Math.abs(summary.champion_probability_team_a - packet.input.expected_summary.champion_probability_team_a) > 1e-6
    || Math.abs(summary.c1_probability_team_a - packet.input.expected_summary.c1_probability_team_a) > 1e-6
    || !Number.isFinite(summary.champion_probability_team_a) || !Number.isFinite(summary.c1_probability_team_a)) throw new Error('diagnosis_schema_frozen_probability');
  if (!output.model_agreement || output.model_agreement.status !== packet.input.expected_agreement.status
    || !Number.isFinite(output.model_agreement.probability_gap)
    || Math.abs(output.model_agreement.probability_gap - packet.input.expected_agreement.probability_gap) > 1e-6) throw new Error('diagnosis_schema_model_agreement');
  if (![output.facts, output.model_signals, output.hypotheses, output.diagnostic_tags].every(Array.isArray)
    || output.hypotheses.length > 3 || output.diagnostic_tags.length > 3
    || !Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1
    || !(output.research_hypothesis === null || typeof output.research_hypothesis === 'string')) throw new Error('diagnosis_schema_fields');
  const references = new Set([...packet.input.fact_evidence, ...packet.input.model_signal_evidence].map((entry) => entry.evidence_id));
  for (const entry of [...output.facts, ...output.model_signals, ...output.hypotheses]) {
    if (!entry || !Array.isArray(entry.evidence_ids) || !entry.evidence_ids.length || entry.evidence_ids.some((id) => !references.has(id))) throw new Error('diagnosis_schema_evidence_reference');
  }
  if ([...output.facts, ...output.model_signals].some((entry) => typeof entry.claim !== 'string' || !entry.claim.trim())
    || output.hypotheses.some((entry) => typeof entry.hypothesis !== 'string' || !entry.hypothesis.trim())) throw new Error('diagnosis_schema_claim_required');
  if (output.diagnostic_tags.some((tag) => !tags.includes(tag))
    || output.hypotheses.some((hypothesis) => !tags.includes(hypothesis.tag) || !Number.isFinite(hypothesis.confidence) || hypothesis.confidence < 0 || hypothesis.confidence > 1)) throw new Error('diagnosis_schema_hypothesis');
}
