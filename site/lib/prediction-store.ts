import { env } from 'cloudflare:workers';
import { fallbackOverview } from './demo-data';
import type { AutomationHealth, AutomationSchedule, ChallengerPrediction, PostmatchAiReview, PostmatchModelDiagnosis, PredictionRecord, PredictionSnapshot, PrematchAiAnalysis, ProspectiveLearningState, PublicOverview } from './vct-types';

type PredictionRow = Record<string, unknown>;

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
  return fallback;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return value ? JSON.parse(asString(value)) as T : fallback; } catch { return fallback; }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid_${field}`);
}

function fromRow(row: PredictionRow): PredictionSnapshot {
  return {
    id: asString(row.id), source: asString(row.source), modelVersion: asString(row.model_version), lockedAt: asString(row.locked_at),
    scheduledAt: asString(row.scheduled_at), event: asString(row.event), region: asString(row.region), patch: row.patch ? asString(row.patch) : null,
    seriesFormat: asString(row.series_format) as 'bo3' | 'bo5', teamA: asString(row.team_a), teamB: asString(row.team_b),
    teamAProbability: Number(row.team_a_probability), predictedScore: asString(row.predicted_score), status: asString(row.status) as 'locked' | 'resolved',
    actualWinner: row.actual_winner ? asString(row.actual_winner) : null, actualScore: row.actual_score ? asString(row.actual_score) : null,
    resolvedAt: row.resolved_at ? asString(row.resolved_at) : null, dataCutoffAt: asString(row.data_cutoff_at),
    factors: parseJson(row.factor_snapshot_json, []), maps: parseJson(row.map_probabilities_json, []),
    scoreDistribution: parseJson(row.score_distribution_json, {}), evidence: parseJson(row.evidence_json, fallbackOverview.prediction.evidence),
  };
}

function recordFromRow(row: PredictionRow): PredictionRecord {
  return {
    ...fromRow(row),
    prematchAiStatus: row.prematch_ai_status ? asString(row.prematch_ai_status) : null,
    prematchAnalysis: row.prematch_ai_json ? parseJson<PrematchAiAnalysis | null>(row.prematch_ai_json, null) : null,
    postmatchAiStatus: row.postmatch_ai_status ? asString(row.postmatch_ai_status) : null,
    postmatchReview: row.postmatch_ai_json ? parseJson<PostmatchAiReview | null>(row.postmatch_ai_json, null) : null,
  };
}

const predictionRecordSelect = `SELECT p.*,
  (SELECT status FROM ai_analyses WHERE prediction_id=p.id AND stage='prematch'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS prematch_ai_status,
  (SELECT output_json FROM ai_analyses WHERE prediction_id=p.id AND stage='prematch' AND status='complete'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS prematch_ai_json,
  (SELECT status FROM ai_analyses WHERE prediction_id=p.id AND stage='postmatch'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS postmatch_ai_status,
  (SELECT output_json FROM ai_analyses WHERE prediction_id=p.id AND stage='postmatch' AND status='complete'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS postmatch_ai_json
  FROM predictions p`;

export async function listPredictionRecords(limit = 100): Promise<PredictionRecord[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await env.DB.prepare(`${predictionRecordSelect}
    WHERE p.source LIKE 'system%'
    ORDER BY datetime(p.scheduled_at) DESC, p.id DESC LIMIT ?`).bind(safeLimit).all<PredictionRow>();
  return (result.results ?? []).map(recordFromRow);
}

export async function predictionRecordById(id: string): Promise<PredictionRecord | null> {
  const row = await env.DB.prepare(`${predictionRecordSelect} WHERE p.id=? LIMIT 1`).bind(id).first<PredictionRow>();
  return row ? recordFromRow(row) : null;
}

export async function listPostmatchReviewRecords(limit = 100): Promise<PredictionRecord[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await env.DB.prepare(`${predictionRecordSelect}
    WHERE p.status='resolved' AND p.source LIKE 'system%' ORDER BY datetime(p.resolved_at) DESC, p.id DESC LIMIT ?`)
    .bind(safeLimit).all<PredictionRow>();
  return (result.results ?? []).map(recordFromRow);
}

export function validatePrediction(value: unknown): PredictionSnapshot {
  if (!value || typeof value !== 'object') throw new Error('prediction_required');
  const item = value as PredictionSnapshot;
  const required = ['id', 'source', 'modelVersion', 'lockedAt', 'scheduledAt', 'event', 'region', 'seriesFormat', 'teamA', 'teamB', 'predictedScore', 'dataCutoffAt'] as const;
  for (const key of required) if (!item[key]) throw new Error(`missing_${key}`);
  if (!['bo3', 'bo5'].includes(item.seriesFormat)) throw new Error('invalid_series_format');
  if (item.status !== 'locked') throw new Error('prediction_must_be_locked');
  if (!(item.teamAProbability > 0 && item.teamAProbability < 1)) throw new Error('invalid_probability');
  assertIsoTimestamp(item.lockedAt, 'locked_at');
  assertIsoTimestamp(item.scheduledAt, 'scheduled_at');
  assertIsoTimestamp(item.dataCutoffAt, 'data_cutoff_at');
  if (Date.parse(item.lockedAt) > Date.parse(item.scheduledAt)) throw new Error('locked_after_scheduled');
  if (Date.parse(item.dataCutoffAt) > Date.parse(item.lockedAt)) throw new Error('data_cutoff_after_lock');
  if (!Array.isArray(item.factors) || !Array.isArray(item.maps)) throw new Error('missing_explanation_snapshot');
  for (const factor of item.factors) {
    if (!factor.key || !factor.label || !Number.isFinite(factor.probabilityPoints) || !Number.isFinite(factor.absoluteShare)) {
      throw new Error('invalid_factor_snapshot');
    }
  }
  for (const map of item.maps) {
    if (!map.map || !(map.teamAProbability > 0 && map.teamAProbability < 1) || Math.abs(map.teamAProbability + map.teamBProbability - 1) > 0.001) {
      throw new Error('invalid_map_snapshot');
    }
  }
  const scoreProbabilities = Object.values(item.scoreDistribution);
  const scoreTotal = scoreProbabilities.reduce((sum, probability) => sum + probability, 0);
  if (scoreProbabilities.length > 0 && (!Number.isFinite(scoreTotal) || Math.abs(scoreTotal - 1) > 0.01)) {
    throw new Error('invalid_score_distribution');
  }
  if (scoreProbabilities.length === 0 && item.source.startsWith('system')) throw new Error('missing_system_score_distribution');
  return item;
}

export async function upsertPrediction(db: D1Database, prediction: PredictionSnapshot): Promise<void> {
  const existing = await predictionById(db, prediction.id);
  if (existing) {
    const immutableMatches = existing.source === prediction.source
      && existing.modelVersion === prediction.modelVersion
      && existing.lockedAt === prediction.lockedAt
      && existing.scheduledAt === prediction.scheduledAt
      && existing.event === prediction.event
      && existing.region === prediction.region
      && existing.patch === prediction.patch
      && existing.seriesFormat === prediction.seriesFormat
      && existing.teamA === prediction.teamA
      && existing.teamB === prediction.teamB
      && Math.abs(existing.teamAProbability - prediction.teamAProbability) < 1e-12
      && existing.predictedScore === prediction.predictedScore
      && existing.dataCutoffAt === prediction.dataCutoffAt
      && sameJson(existing.factors, prediction.factors)
      && sameJson(existing.maps, prediction.maps)
      && sameJson(existing.scoreDistribution, prediction.scoreDistribution)
      && sameJson(existing.evidence, prediction.evidence);
    if (!immutableMatches) throw new Error('prediction_snapshot_conflict');
    return;
  }
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO predictions (
    id, source, model_version, locked_at, scheduled_at, event, region, patch, series_format, team_a, team_b,
    team_a_probability, predicted_score, status, actual_winner, actual_score, resolved_at, data_cutoff_at,
    factor_snapshot_json, map_probabilities_json, score_distribution_json, evidence_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status=excluded.status, actual_winner=COALESCE(excluded.actual_winner, predictions.actual_winner),
    actual_score=COALESCE(excluded.actual_score, predictions.actual_score), resolved_at=COALESCE(excluded.resolved_at, predictions.resolved_at),
    updated_at=excluded.updated_at`).bind(
      prediction.id, prediction.source, prediction.modelVersion, prediction.lockedAt, prediction.scheduledAt, prediction.event,
      prediction.region, prediction.patch ?? null, prediction.seriesFormat, prediction.teamA, prediction.teamB, prediction.teamAProbability,
      prediction.predictedScore, prediction.status, prediction.actualWinner ?? null, prediction.actualScore ?? null, prediction.resolvedAt ?? null,
      prediction.dataCutoffAt, JSON.stringify(prediction.factors), JSON.stringify(prediction.maps), JSON.stringify(prediction.scoreDistribution),
      JSON.stringify(prediction.evidence), now, now,
    ).run();
}

export async function latestPrediction(db: D1Database): Promise<PredictionSnapshot | null> {
  const row = await db.prepare("SELECT * FROM predictions WHERE source LIKE 'system%' ORDER BY datetime(scheduled_at) DESC LIMIT 1").first<PredictionRow>();
  return row ? fromRow(row) : null;
}

export async function predictionById(db: D1Database, id: string): Promise<PredictionSnapshot | null> {
  const row = await db.prepare('SELECT * FROM predictions WHERE id = ? LIMIT 1').bind(id).first<PredictionRow>();
  return row ? fromRow(row) : null;
}

export async function resolvePrediction(db: D1Database, id: string, winner: string, score: string, resolvedAt: string): Promise<PredictionSnapshot> {
  const existing = await predictionById(db, id);
  if (!existing) throw new Error('prediction_not_found');
  if (![existing.teamA, existing.teamB].includes(winner)) throw new Error('actual_winner_not_in_match');
  if (!/^\d+-\d+$/.test(score)) throw new Error('invalid_actual_score');
  assertIsoTimestamp(resolvedAt, 'resolved_at');
  if (Date.parse(resolvedAt) < Date.parse(existing.scheduledAt)) throw new Error('resolved_before_scheduled');
  if (existing.status === 'resolved') {
    if (existing.actualWinner !== winner || existing.actualScore !== score) throw new Error('result_conflict');
    return existing;
  }
  const resolved = { ...existing, status: 'resolved' as const, actualWinner: winner, actualScore: score, resolvedAt };
  await db.prepare(`UPDATE predictions SET status='resolved', actual_winner=?, actual_score=?, resolved_at=?, updated_at=?
    WHERE id=? AND status='locked'`).bind(winner, score, resolvedAt, new Date().toISOString(), id).run();
  return resolved;
}

function challengerFromRow(row: PredictionRow): ChallengerPrediction {
  return {
    id: asString(row.id), fixtureId: asString(row.fixture_id), championPredictionId: asString(row.champion_prediction_id),
    featureSnapshotId: asString(row.feature_snapshot_id), featureSnapshotHash: asString(row.feature_snapshot_hash),
    features: parseJson(row.feature_json, {}), featureStatus: parseJson(row.feature_status_json, {}), evidence: parseJson(row.evidence_json, {}),
    frozenAt: asString(row.frozen_at), scheduledAt: asString(row.scheduled_at), championModelVersion: asString(row.champion_model_version),
    championProbability: Number(row.champion_probability), challengerModelId: asString(row.challenger_model_id), datasetVersion: asString(row.dataset_version),
    artifactHash: asString(row.artifact_hash), challengerProbability: Number(row.challenger_probability), probabilityDelta: Number(row.probability_delta),
    dataQualityState: asString(row.data_quality_state), recordKind: asString(row.record_kind) as ChallengerPrediction['recordKind'],
    eligible: Boolean(row.eligible), status: asString(row.status) as ChallengerPrediction['status'], actualWinner: row.actual_winner ? asString(row.actual_winner) : null,
    resolvedAt: row.resolved_at ? asString(row.resolved_at) : null, championBrier: row.champion_brier == null ? null : Number(row.champion_brier),
    challengerBrier: row.challenger_brier == null ? null : Number(row.challenger_brier), championLogLoss: row.champion_log_loss == null ? null : Number(row.champion_log_loss),
    challengerLogLoss: row.challenger_log_loss == null ? null : Number(row.challenger_log_loss), championCorrect: row.champion_correct == null ? null : Boolean(row.champion_correct),
    challengerCorrect: row.challenger_correct == null ? null : Boolean(row.challenger_correct),
  };
}

export function validateChallengerPrediction(value: unknown): ChallengerPrediction {
  if (!value || typeof value !== 'object') throw new Error('challenger_prediction_required');
  const item = value as ChallengerPrediction;
  for (const key of ['id', 'fixtureId', 'championPredictionId', 'featureSnapshotId', 'featureSnapshotHash', 'frozenAt', 'scheduledAt', 'championModelVersion', 'challengerModelId', 'datasetVersion', 'artifactHash', 'dataQualityState', 'recordKind', 'status'] as const) {
    if (!item[key]) throw new Error(`missing_challenger_${key}`);
  }
  assertIsoTimestamp(item.frozenAt, 'challenger_frozen_at');
  assertIsoTimestamp(item.scheduledAt, 'challenger_scheduled_at');
  if (Date.parse(item.frozenAt) >= Date.parse(item.scheduledAt)) throw new Error('challenger_not_frozen_prematch');
  if (![item.championProbability, item.challengerProbability].every((number) => Number.isFinite(number) && number >= 0 && number <= 1)) throw new Error('invalid_challenger_probability');
  if (Math.abs(item.probabilityDelta - (item.challengerProbability - item.championProbability)) > 1e-9) throw new Error('invalid_probability_delta');
  if (!['real_prospective', 'isolated_test'].includes(item.recordKind) || !['locked', 'resolved'].includes(item.status)) throw new Error('invalid_challenger_state');
  if (!item.features || !item.featureStatus || !item.evidence) throw new Error('missing_challenger_snapshot');
  return item;
}

export async function challengerByChampion(db: D1Database, championPredictionId: string): Promise<ChallengerPrediction | null> {
  const row = await db.prepare('SELECT * FROM challenger_predictions WHERE champion_prediction_id=? LIMIT 1').bind(championPredictionId).first<PredictionRow>();
  return row ? challengerFromRow(row) : null;
}

export async function upsertChallengerPrediction(db: D1Database, item: ChallengerPrediction): Promise<void> {
  const existing = await challengerByChampion(db, item.championPredictionId);
  if (existing) {
    const immutableMatches = existing.id === item.id && existing.fixtureId === item.fixtureId && existing.featureSnapshotId === item.featureSnapshotId
      && existing.featureSnapshotHash === item.featureSnapshotHash && existing.frozenAt === item.frozenAt && existing.scheduledAt === item.scheduledAt
      && existing.championModelVersion === item.championModelVersion && Math.abs(existing.championProbability - item.championProbability) < 1e-12
      && existing.challengerModelId === item.challengerModelId && existing.datasetVersion === item.datasetVersion && existing.artifactHash === item.artifactHash
      && Math.abs(existing.challengerProbability - item.challengerProbability) < 1e-12 && Math.abs(existing.probabilityDelta - item.probabilityDelta) < 1e-12
      && existing.dataQualityState === item.dataQualityState && existing.recordKind === item.recordKind && existing.eligible === item.eligible
      && sameJson(existing.features, item.features) && sameJson(existing.featureStatus, item.featureStatus) && sameJson(existing.evidence, item.evidence);
    if (!immutableMatches) throw new Error('challenger_snapshot_conflict');
    return;
  }
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO challenger_predictions(id,fixture_id,champion_prediction_id,feature_snapshot_id,feature_snapshot_hash,
    feature_json,feature_status_json,evidence_json,frozen_at,scheduled_at,champion_model_version,champion_probability,
    challenger_model_id,dataset_version,artifact_hash,challenger_probability,probability_delta,data_quality_state,record_kind,
    eligible,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      item.id, item.fixtureId, item.championPredictionId, item.featureSnapshotId, item.featureSnapshotHash, JSON.stringify(item.features),
      JSON.stringify(item.featureStatus), JSON.stringify(item.evidence), item.frozenAt, item.scheduledAt, item.championModelVersion,
      item.championProbability, item.challengerModelId, item.datasetVersion, item.artifactHash, item.challengerProbability,
      item.probabilityDelta, item.dataQualityState, item.recordKind, item.eligible ? 1 : 0, 'locked', now, now,
    ).run();
}

export async function resolveChallenger(db: D1Database, champion: PredictionSnapshot, winner: string, resolvedAt: string): Promise<ChallengerPrediction | null> {
  const existing = await challengerByChampion(db, champion.id);
  if (!existing) return null;
  if (existing.status === 'resolved') {
    if (existing.actualWinner !== winner) throw new Error('challenger_result_conflict');
    return existing;
  }
  const outcome = winner === champion.teamA ? 1 : 0;
  const score = (probability: number) => -Math.log(Math.min(Math.max(outcome ? probability : 1 - probability, 1e-15), 1 - 1e-15));
  const championCorrect = (existing.championProbability >= 0.5) === Boolean(outcome);
  const challengerCorrect = (existing.challengerProbability >= 0.5) === Boolean(outcome);
  await db.prepare(`UPDATE challenger_predictions SET status='resolved',actual_winner=?,resolved_at=?,champion_brier=?,challenger_brier=?,
    champion_log_loss=?,challenger_log_loss=?,champion_correct=?,challenger_correct=?,updated_at=? WHERE id=? AND status='locked'`).bind(
      winner, resolvedAt, (existing.championProbability-outcome)**2, (existing.challengerProbability-outcome)**2,
      score(existing.championProbability), score(existing.challengerProbability), championCorrect ? 1 : 0, challengerCorrect ? 1 : 0,
      new Date().toISOString(), existing.id,
    ).run();
  return challengerByChampion(db, champion.id);
}

export async function saveModelDiagnosis(db: D1Database, input: {
  challenger: ChallengerPrediction; modelId: string; promptVersion: string; status: string; result: object;
  output?: PostmatchModelDiagnosis; errorCode?: string;
}): Promise<void> {
  await db.prepare(`INSERT INTO challenger_diagnoses(id,challenger_prediction_id,champion_prediction_id,created_at,provider,model_id,
    prompt_version,schema_version,status,result_json,facts_json,model_signals_json,hypotheses_json,tags_json,research_hypothesis,
    evidence_references_json,confidence,error_code,direct_model_control_allowed) VALUES(?,?,?,?,'deepseek',?,?,'v1.4c-diagnosis-v1',?,?,?,?,?,?,?,?,?,?,0)`).bind(
      crypto.randomUUID(), input.challenger.id, input.challenger.championPredictionId, new Date().toISOString(), input.modelId, input.promptVersion,
      input.status, JSON.stringify(input.result), input.output ? JSON.stringify(input.output.facts) : null,
      input.output ? JSON.stringify(input.output.model_signals) : null, input.output ? JSON.stringify(input.output.hypotheses) : null,
      input.output ? JSON.stringify(input.output.diagnostic_tags) : null, input.output?.research_hypothesis ?? null,
      input.output ? JSON.stringify([...new Set([...input.output.facts, ...input.output.model_signals, ...input.output.hypotheses].flatMap((entry) => entry.evidence_ids))]) : null,
      input.output?.confidence ?? null, input.errorCode ?? null,
    ).run();
}

export async function latestModelDiagnosisStatus(db: D1Database, challengerPredictionId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT status FROM challenger_diagnoses WHERE challenger_prediction_id=?
    ORDER BY datetime(created_at) DESC LIMIT 1`).bind(challengerPredictionId).first<PredictionRow>();
  return row ? asString(row.status) : null;
}

export async function aggregatedDiagnosisTags(db: D1Database, minimumSample = 10): Promise<{
  status: 'READY' | 'INSUFFICIENT_SAMPLE'; resolvedDiagnoses: number; minimumSample: number; tags: Record<string, number>;
}> {
  const rows = await db.prepare(`SELECT tags_json FROM challenger_diagnoses d
    JOIN challenger_predictions c ON c.id=d.challenger_prediction_id
    WHERE d.status='complete' AND c.status='resolved' ORDER BY datetime(d.created_at)`).all<PredictionRow>();
  const results = rows.results ?? [];
  if (results.length < minimumSample) return { status: 'INSUFFICIENT_SAMPLE', resolvedDiagnoses: results.length, minimumSample, tags: {} };
  const tags: Record<string, number> = {};
  for (const row of results) for (const tag of parseJson<string[]>(row.tags_json, [])) tags[tag] = (tags[tag] ?? 0) + 1;
  return { status: 'READY', resolvedDiagnoses: results.length, minimumSample, tags };
}

export async function latestAiAnalysisStatus(db: D1Database, predictionId: string, stage: 'prematch' | 'postmatch'): Promise<string | null> {
  const row = await db.prepare(`SELECT status FROM ai_analyses WHERE prediction_id=? AND stage=?
    ORDER BY datetime(created_at) DESC LIMIT 1`).bind(predictionId, stage).first<Record<string, unknown>>();
  return row ? asString(row.status) : null;
}

export async function failedAiAnalysisCount(
  db: D1Database,
  predictionId: string,
  stage: 'prematch' | 'postmatch',
  promptVersion: string,
): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ai_analyses
    WHERE prediction_id=? AND stage=? AND prompt_version=? AND status='failed'`)
    .bind(predictionId, stage, promptVersion).first<Record<string, unknown>>();
  return Number(row?.count ?? 0);
}

export async function saveAiAnalysis(db: D1Database, input: {
  predictionId: string; stage: 'prematch' | 'postmatch'; modelId: string; promptVersion: string; status: string; output?: object; errorCode?: string;
}): Promise<void> {
  await db.prepare(`INSERT INTO ai_analyses (
    id, prediction_id, stage, provider, model_id, prompt_version, status, output_json, error_code, direct_promotion_allowed, created_at
  ) VALUES (?, ?, ?, 'deepseek', ?, ?, ?, ?, ?, 0, ?)`).bind(
    crypto.randomUUID(), input.predictionId, input.stage, input.modelId, input.promptVersion, input.status,
    input.output ? JSON.stringify(input.output) : null, input.errorCode ?? null, new Date().toISOString(),
  ).run();
}

export async function saveAutomationState(db: D1Database, input: {
  coverage: PublicOverview['data'];
  model: { version: string; role: string; status: string; parentVersion?: string | null; trainingCutoff?: string | null; minimumSampleGate: number; observedSamples: number; metrics: object; constraints: object };
  run?: { id: string; runType: string; status: string; startedAt: string; completedAt?: string | null; counters: object; errorCode?: string | null };
  schedule?: AutomationSchedule;
  learning?: ProspectiveLearningState;
  challenger?: object;
}): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    db.prepare(`INSERT INTO data_state(key, value_json, updated_at) VALUES('coverage', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .bind(JSON.stringify(input.coverage), now),
    db.prepare(`INSERT INTO model_versions(version, role, status, parent_version, training_cutoff, minimum_sample_gate,
      observed_samples, metrics_json, constraints_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET role=excluded.role, status=excluded.status,
      training_cutoff=excluded.training_cutoff, minimum_sample_gate=excluded.minimum_sample_gate,
      observed_samples=excluded.observed_samples, metrics_json=excluded.metrics_json,
      constraints_json=excluded.constraints_json`)
      .bind(input.model.version, input.model.role, input.model.status, input.model.parentVersion ?? null,
        input.model.trainingCutoff ?? null, input.model.minimumSampleGate, input.model.observedSamples,
        JSON.stringify(input.model.metrics), JSON.stringify(input.model.constraints), now),
  ];
  if (input.run) {
    statements.push(db.prepare(`INSERT INTO automation_runs(
      id, run_type, status, started_at, completed_at, counters_json, error_code
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at,
      counters_json=excluded.counters_json, error_code=excluded.error_code`).bind(
        input.run.id, input.run.runType, input.run.status, input.run.startedAt,
        input.run.completedAt ?? null, JSON.stringify(input.run.counters), input.run.errorCode ?? null,
      ));
  }
  if (input.schedule) {
    statements.push(db.prepare(`INSERT INTO data_state(key, value_json, updated_at) VALUES('automation_schedule', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .bind(JSON.stringify(input.schedule), now));
  }
  if (input.learning) {
    statements.push(db.prepare(`INSERT INTO data_state(key, value_json, updated_at) VALUES('learning_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .bind(JSON.stringify(input.learning), now));
  }
  if (input.challenger) {
    statements.push(db.prepare(`INSERT INTO data_state(key, value_json, updated_at) VALUES('challenger_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .bind(JSON.stringify(input.challenger), now));
  }
  await db.batch(statements);
}

export async function loadAutomationHealth(): Promise<AutomationHealth> {
  const [runRow, scheduleRow, coverageRow, aiRow, queueRow] = await Promise.all([
    env.DB.prepare(`SELECT status, started_at, completed_at, counters_json, error_code
      FROM automation_runs ORDER BY datetime(started_at) DESC LIMIT 1`).first<PredictionRow>(),
    env.DB.prepare(`SELECT value_json FROM data_state WHERE key='automation_schedule' LIMIT 1`).first<PredictionRow>(),
    env.DB.prepare(`SELECT updated_at FROM data_state WHERE key='coverage' LIMIT 1`).first<PredictionRow>(),
    env.DB.prepare(`SELECT MAX(created_at) AS completed_at FROM ai_analyses WHERE status='complete'`).first<PredictionRow>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN source LIKE 'system%' AND status='locked' THEN 1 ELSE 0 END) AS pending_results,
      SUM(CASE WHEN source LIKE 'system%' AND status='resolved' AND NOT EXISTS (
        SELECT 1 FROM ai_analyses a WHERE a.prediction_id=predictions.id AND a.stage='postmatch' AND a.status='complete'
      ) THEN 1 ELSE 0 END) AS pending_reviews
      FROM predictions`).first<PredictionRow>(),
  ]);
  const schedule = scheduleRow?.value_json
    ? parseJson<AutomationSchedule>(scheduleRow.value_json, { intervalSeconds: 7200, horizonHours: 48, executionEnvironment: 'cloud' })
    : { intervalSeconds: 7200, horizonHours: 48, executionEnvironment: 'cloud' as const };
  const lastRunStartedAt = runRow?.started_at ? asString(runRow.started_at) : null;
  const lastRunCompletedAt = runRow?.completed_at ? asString(runRow.completed_at) : null;
  const intervalSeconds = Number(schedule.intervalSeconds || 7200);
  const lastCompletedMs = lastRunCompletedAt ? Date.parse(lastRunCompletedAt) : Number.NaN;
  const nextExpectedAt = Number.isFinite(lastCompletedMs) ? new Date(lastCompletedMs + intervalSeconds * 1000).toISOString() : null;
  const staleAfterMs = intervalSeconds * 2.5 * 1000;
  let status: AutomationHealth['status'] = 'waiting';
  if (runRow) {
    const failed = Boolean(runRow.error_code) || ['failed', 'partial_failure'].includes(asString(runRow.status));
    status = failed ? 'degraded' : !Number.isFinite(lastCompletedMs) || Date.now() - lastCompletedMs > staleAfterMs ? 'stale' : 'healthy';
  }
  return {
    status,
    lastRunStatus: runRow?.status ? asString(runRow.status) : null,
    lastRunStartedAt,
    lastRunCompletedAt,
    nextExpectedAt,
    dataUpdatedAt: coverageRow?.updated_at ? asString(coverageRow.updated_at) : null,
    lastAiCompletedAt: aiRow?.completed_at ? asString(aiRow.completed_at) : null,
    intervalSeconds,
    horizonHours: Number(schedule.horizonHours || 48),
    pendingResults: Number(queueRow?.pending_results ?? 0),
    pendingReviews: Number(queueRow?.pending_reviews ?? 0),
    lastCounters: parseJson<Record<string, unknown>>(runRow?.counters_json, {}),
  };
}

export async function loadPublicOverview(): Promise<PublicOverview> {
  const modelId = env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  try {
    const prediction = await latestPrediction(env.DB) ?? fallbackOverview.prediction;
    const automation = await loadAutomationHealth();
    const analysisRow = await env.DB.prepare(`SELECT output_json, status FROM ai_analyses
      WHERE prediction_id = ? AND stage = 'prematch' ORDER BY datetime(created_at) DESC LIMIT 1`).bind(prediction.id).first<Record<string, unknown>>();
    const counts = await env.DB.prepare(`SELECT COUNT(*) AS predictions,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved FROM predictions
      WHERE source LIKE 'system%'`).first<Record<string, number>>();
    const modelRow = await env.DB.prepare(`SELECT version, observed_samples, minimum_sample_gate, status FROM model_versions
      WHERE role='champion' ORDER BY datetime(created_at) DESC LIMIT 1`).first<Record<string, unknown>>();
    const coverageRow = await env.DB.prepare(`SELECT value_json FROM data_state WHERE key='coverage' LIMIT 1`).first<Record<string, unknown>>();
    const learningRow = await env.DB.prepare(`SELECT value_json FROM data_state WHERE key='learning_state' LIMIT 1`).first<Record<string, unknown>>();
    const coverage = coverageRow?.value_json
      ? parseJson<Partial<PublicOverview['data']>>(coverageRow.value_json, {})
      : {};
    return {
      prediction,
      data: {
        ...fallbackOverview.data,
        ...coverage,
        predictions: Number(counts?.predictions ?? coverage.predictions ?? fallbackOverview.data.predictions),
      },
      ai: {
        configured: Boolean(env.DEEPSEEK_API_KEY), status: analysisRow?.status === 'complete' ? 'available' : env.DEEPSEEK_API_KEY ? 'ready' : 'waiting_for_key',
        modelId, analysis: analysisRow?.output_json ? parseJson<PrematchAiAnalysis | null>(analysisRow.output_json, null) : null,
      },
      governance: {
        champion: asString(modelRow?.version, fallbackOverview.governance.champion), globalWeightsFrozen: true,
        observedSamples: Number(modelRow?.observed_samples ?? counts?.resolved ?? fallbackOverview.governance.observedSamples),
        minimumSampleGate: Number(modelRow?.minimum_sample_gate ?? fallbackOverview.governance.minimumSampleGate), promotionEnabled: false,
      },
      automation,
      learning: learningRow?.value_json
        ? parseJson<ProspectiveLearningState>(learningRow.value_json, fallbackOverview.learning)
        : fallbackOverview.learning,
    };
  } catch {
    return { ...fallbackOverview, ai: { ...fallbackOverview.ai, configured: Boolean(env.DEEPSEEK_API_KEY), modelId } };
  }
}
