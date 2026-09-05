import type { ChallengerPrediction, PostmatchAiReview, PostmatchModelDiagnosis, PredictionSnapshot, PrematchAiAnalysis } from './vct-types';

export const PREMATCH_PROMPT_VERSION = 'vct-prematch-deepseek-v2';
export const POSTMATCH_PROMPT_VERSION = 'vct-postmatch-deepseek-v2';
export const MODEL_DIAGNOSIS_PROMPT_VERSION = 'vct-postmatch-model-diagnosis-v1.4c';

const commonRules = `你是 VCT Forecast Lab 的受限分析层，不是自由发挥的赛事评论员。只能使用输入 JSON 中明确存在的赛前证据，并通过 evidence_id 指向证据；禁止补造 BP、Patch、逐回合战术、阵容、新闻、选手心理或未给出的地图。赛前分析不得使用比赛开始后的信息。先解释正式数学模型为何得出当前概率，再给出双方可验证的胜负条件、地图差异、缺失数据与反证触发器。明确区分低样本、不确定性、正常随机波动和模型错误。数学模型是唯一正式概率源，你的概率只作为影子评估。优化建议只能成为待回测假设，必须写出目标变量和验证方法，不得直接修改、发布或晋级模型。所有地图名使用输入中的中文名称。语言具体、可证伪，避免“状态更好”“发挥稳定”等无证据套话。输出必须符合 JSON Schema。`;

const prematchSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    stage: { type: 'string', const: 'prematch' },
    ai_probability_team_a: { type: 'number', minimum: 0.02, maximum: 0.98 },
    predicted_score: { type: 'string' }, summary: { type: 'string' },
    key_factors: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, properties: {
      factor: { type: 'string' }, direction: { type: 'string', enum: ['team_a', 'team_b', 'neutral'] }, claim: { type: 'string' },
      importance: { type: 'number', minimum: 0, maximum: 1 }, evidence_ids: { type: 'array', items: { type: 'string' } },
    }, required: ['factor', 'direction', 'importance', 'evidence_ids', 'claim'] } },
    risk_flags: { type: 'array', items: { type: 'string' } }, upset_conditions: { type: 'array', items: { type: 'string' } },
    model_disagreement: { type: 'string' }, optimization_hypotheses: { type: 'array', items: { type: 'string' } },
    evidence_grade: { type: 'string', enum: ['high', 'medium', 'low'] },
    official_model_reading: { type: 'object', additionalProperties: false, properties: {
      favored_team: { type: 'string' }, probability_gap_pp: { type: 'number' }, strongest_support: { type: 'string' }, strongest_counterweight: { type: 'string' },
    }, required: ['favored_team', 'probability_gap_pp', 'strongest_support', 'strongest_counterweight'] },
    team_a_win_conditions: { type: 'array', maxItems: 5, items: { type: 'string' } },
    team_b_win_conditions: { type: 'array', maxItems: 5, items: { type: 'string' } },
    map_analysis: { type: 'array', maxItems: 7, items: { type: 'object', additionalProperties: false, properties: {
      map: { type: 'string' }, team_a_probability: { type: 'number', minimum: 0.02, maximum: 0.98 }, interpretation: { type: 'string' },
      sample_warning: { type: 'string' }, evidence_ids: { type: 'array', items: { type: 'string' } },
    }, required: ['map', 'team_a_probability', 'interpretation', 'sample_warning', 'evidence_ids'] } },
    uncertainty: { type: 'object', additionalProperties: false, properties: {
      missing_data: { type: 'array', items: { type: 'string' } }, low_sample_signals: { type: 'array', items: { type: 'string' } },
      invalidation_triggers: { type: 'array', items: { type: 'string' } },
    }, required: ['missing_data', 'low_sample_signals', 'invalidation_triggers'] },
    structured_hypotheses: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, properties: {
      hypothesis: { type: 'string' }, target_feature: { type: 'string' }, expected_effect: { type: 'string' }, validation_plan: { type: 'string' },
    }, required: ['hypothesis', 'target_feature', 'expected_effect', 'validation_plan'] } },
    direct_promotion_allowed: { type: 'boolean', const: false },
  },
  required: ['stage', 'ai_probability_team_a', 'predicted_score', 'summary', 'key_factors', 'risk_flags', 'upset_conditions', 'model_disagreement', 'optimization_hypotheses', 'evidence_grade', 'official_model_reading', 'team_a_win_conditions', 'team_b_win_conditions', 'map_analysis', 'uncertainty', 'structured_hypotheses', 'direct_promotion_allowed'],
};

const postmatchSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    stage: { type: 'string', const: 'postmatch' }, summary: { type: 'string' },
    result_classification: { type: 'string', enum: ['normal_variance', 'calibration_issue', 'data_issue', 'candidate_model_issue'] },
    evidence: { type: 'array', items: { type: 'string' } }, error_drivers: { type: 'array', items: { type: 'string' } },
    candidate_hypotheses: { type: 'array', items: { type: 'string' } },
    outcome_evaluation: { type: 'object', additionalProperties: false, properties: {
      winner_correct: { type: 'boolean' }, score_correct: { type: 'boolean' }, probability_was_reasonable: { type: 'boolean' }, calibration_comment: { type: 'string' },
    }, required: ['winner_correct', 'score_correct', 'probability_was_reasonable', 'calibration_comment'] },
    validated_factors: { type: 'array', items: { type: 'string' } }, invalidated_factors: { type: 'array', items: { type: 'string' } },
    map_review: { type: 'array', maxItems: 7, items: { type: 'object', additionalProperties: false, properties: {
      map: { type: 'string' }, pre_match_reading: { type: 'string' }, actual_evidence: { type: 'string' }, conclusion: { type: 'string' },
    }, required: ['map', 'pre_match_reading', 'actual_evidence', 'conclusion'] } },
    variance_vs_model_error: { type: 'object', additionalProperties: false, properties: {
      verdict: { type: 'string', enum: ['variance', 'model_error', 'mixed', 'insufficient_evidence'] }, explanation: { type: 'string' },
    }, required: ['verdict', 'explanation'] },
    structured_hypotheses: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, properties: {
      hypothesis: { type: 'string' }, target_feature: { type: 'string' }, validation_plan: { type: 'string' }, no_direct_change: { type: 'boolean', const: true },
    }, required: ['hypothesis', 'target_feature', 'validation_plan', 'no_direct_change'] } },
    retraining_recommendation: { type: 'string', enum: ['none', 'shadow_experiment'] },
    direct_promotion_allowed: { type: 'boolean', const: false },
  },
  required: ['stage', 'summary', 'result_classification', 'evidence', 'error_drivers', 'candidate_hypotheses', 'outcome_evaluation', 'validated_factors', 'invalidated_factors', 'map_review', 'variance_vs_model_error', 'structured_hypotheses', 'retraining_recommendation', 'direct_promotion_allowed'],
};

const diagnosisTags = ['rating_lag', 'recent_form', 'roster_change', 'map_matchup', 'player_form', 'cross_region', 'missing_context', 'calibration', 'unexplained'];
const evidenceClaim = { type: 'object', additionalProperties: false, properties: {
  claim: { type: 'string' }, evidence_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
}, required: ['claim', 'evidence_ids'] };
const modelDiagnosisSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    stage: { type: 'string', const: 'postmatch_model_diagnosis' },
    prediction_summary: { type: 'object', additionalProperties: false, properties: {
      champion_probability_team_a: { type: 'number', minimum: 0, maximum: 1 }, c1_probability_team_a: { type: 'number', minimum: 0, maximum: 1 }, actual_winner: { type: 'string' },
    }, required: ['champion_probability_team_a', 'c1_probability_team_a', 'actual_winner'] },
    model_agreement: { type: 'object', additionalProperties: false, properties: {
      status: { type: 'string', enum: ['models_agreed', 'models_disagreed'] }, probability_gap: { type: 'number' },
    }, required: ['status', 'probability_gap'] },
    facts: { type: 'array', maxItems: 8, items: evidenceClaim },
    model_signals: { type: 'array', maxItems: 8, items: evidenceClaim },
    hypotheses: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, properties: {
      hypothesis: { type: 'string' }, tag: { type: 'string', enum: diagnosisTags }, evidence_ids: { type: 'array', minItems: 1, items: { type: 'string' } }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    }, required: ['hypothesis', 'tag', 'evidence_ids', 'confidence'] } },
    diagnostic_tags: { type: 'array', maxItems: 3, items: { type: 'string', enum: diagnosisTags } },
    research_hypothesis: { type: ['string', 'null'] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    direct_probability_change_allowed: { type: 'boolean', const: false }, direct_training_allowed: { type: 'boolean', const: false }, direct_promotion_allowed: { type: 'boolean', const: false },
  },
  required: ['stage', 'prediction_summary', 'model_agreement', 'facts', 'model_signals', 'hypotheses', 'diagnostic_tags', 'research_hypothesis', 'confidence', 'direct_probability_change_allowed', 'direct_training_allowed', 'direct_promotion_allowed'],
};

function outputText(payload: unknown): string {
  const record = payload as {
    output_text?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string } | null;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  };
  if (record.output_text) return record.output_text;
  for (const item of record.output ?? []) for (const part of item.content ?? []) if (part.type === 'output_text' && part.text) return part.text;
  if (record.status === 'incomplete') throw new Error(`deepseek_incomplete_${record.incomplete_details?.reason || 'unknown'}`);
  if (record.status === 'failed') throw new Error(`deepseek_response_failed_${record.error?.code || 'unknown'}`);
  throw new Error('deepseek_empty_output');
}

async function requestJson<T>(options: {
  apiKey: string; modelId: string; promptVersion: string; schemaName: string; schema: object; input: object;
}): Promise<{ output: T; modelId: string; promptVersion: string }> {
  const response = await fetch('https://api.deepseek.com/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.modelId,
      instructions: commonRules,
      input: JSON.stringify(options.input),
      reasoning: { effort: 'high' },
      max_output_tokens: 6000,
      text: { format: { type: 'json_schema', name: options.schemaName, schema: options.schema } },
    }),
  });
  if (!response.ok) throw new Error(`deepseek_http_${response.status}`);
  const payload = await response.json();
  const parsed = JSON.parse(outputText(payload)) as T;
  return { output: parsed, modelId: options.modelId, promptVersion: options.promptVersion };
}

function prematchInput(prediction: PredictionSnapshot) {
  return {
    stage: 'prematch', prediction_id: prediction.id, locked_at: prediction.lockedAt, scheduled_at: prediction.scheduledAt,
    data_cutoff_at: prediction.dataCutoffAt, event: prediction.event, region: prediction.region, patch: prediction.patch,
    series_format: prediction.seriesFormat, teams: { team_a: prediction.teamA, team_b: prediction.teamB },
    official_math_probability_team_a: prediction.teamAProbability, official_predicted_score: prediction.predictedScore,
    factor_contributions: prediction.factors.map((factor) => ({ evidence_id: `factor:${factor.key}`, ...factor })),
    map_probabilities: prediction.maps.map((map) => ({ evidence_id: `map:${map.map}`, ...map })),
    score_distribution: prediction.scoreDistribution, evidence_boundary: prediction.evidence,
  };
}

export function analyzePrematch(apiKey: string, modelId: string, prediction: PredictionSnapshot) {
  return requestJson<PrematchAiAnalysis>({ apiKey, modelId, promptVersion: PREMATCH_PROMPT_VERSION, schemaName: 'vct_prematch_analysis', schema: prematchSchema, input: prematchInput(prediction) });
}

export function analyzePostmatch(apiKey: string, modelId: string, prediction: PredictionSnapshot) {
  return requestJson<PostmatchAiReview>({
    apiKey, modelId, promptVersion: POSTMATCH_PROMPT_VERSION, schemaName: 'vct_postmatch_review', schema: postmatchSchema,
    input: { ...prematchInput(prediction), stage: 'postmatch', actual_winner: prediction.actualWinner, actual_score: prediction.actualScore, resolved_at: prediction.resolvedAt },
  });
}

export function analyzePostmatchModelDiagnosis(apiKey: string, modelId: string, prediction: PredictionSnapshot, challenger: ChallengerPrediction) {
  const featureEvidence = Object.entries(challenger.features).map(([feature, value]) => ({
    evidence_id: `c1_feature:${feature}`, feature, value, status: challenger.featureStatus[feature],
  }));
  const input = {
    stage: 'postmatch_model_diagnosis',
    evidence_boundary: {
      rule: 'FACT only from supplied evidence; MODEL SIGNAL only from frozen model inputs/outputs; every causal explanation is HYPOTHESIS.',
      direct_probability_change_allowed: false, direct_training_allowed: false, direct_promotion_allowed: false,
    },
    fact_evidence: [
      { evidence_id: 'fact:result', actual_winner: prediction.actualWinner, actual_score: prediction.actualScore, resolved_at: prediction.resolvedAt },
      { evidence_id: 'fact:freeze_order', champion_locked_at: prediction.lockedAt, c1_frozen_at: challenger.frozenAt, scheduled_at: prediction.scheduledAt },
    ],
    model_signal_evidence: [
      { evidence_id: 'model:champion', model: prediction.modelVersion, probability_team_a: prediction.teamAProbability, factors: prediction.factors },
      { evidence_id: 'model:c1', model: challenger.challengerModelId, dataset_version: challenger.datasetVersion, artifact_hash: challenger.artifactHash, probability_team_a: challenger.challengerProbability },
      ...featureEvidence,
    ],
    teams: { team_a: prediction.teamA, team_b: prediction.teamB },
  };
  return requestJson<PostmatchModelDiagnosis>({ apiKey, modelId, promptVersion: MODEL_DIAGNOSIS_PROMPT_VERSION, schemaName: 'vct_postmatch_model_diagnosis', schema: modelDiagnosisSchema, input });
}

export function deepSeekModel(env: Cloudflare.Env): string { return env.DEEPSEEK_MODEL || 'deepseek-v4-pro'; }
