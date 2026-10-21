import { env } from 'cloudflare:workers';
import { fallbackOverview } from './demo-data';
import {
  EDITORIAL_REVIEW_PROMPT,
  EDITORIAL_REVIEW_SCHEMA,
} from './review-editorial.ts';
import {
  computePostmatchScorecard,
  validateActualScore,
  validateResultCorrection,
  validateResultEvidence,
} from './postmatch-scorecard';
import {
  logicalJobKey,
  matchesArchivedResultDelivery,
  packetWithHashes,
  POSTMATCH_JOB_PROMPT_VERSION,
  POSTMATCH_JOB_SCHEMA_VERSION,
  PREMATCH_JOB_PROMPT_VERSION,
  PREMATCH_JOB_SCHEMA_VERSION,
  providerHealth,
  RETRY_POLICY_VERSION,
  retrySchedule,
  sameFrozenMapSnapshot,
  sameFrozenResultEvidence,
  sha256,
} from './ai-reliability';
import { prematchInput } from './deepseek';
import { validatedPrematchContext } from './prematch-context.ts';
import type { PrematchReaderContext } from './prematch-context.ts';
import {
  buildDiagnosisPacket,
  DIAGNOSIS_JOB_PROMPT_VERSION,
  DIAGNOSIS_JOB_SCHEMA_VERSION,
} from './model-diagnosis';
import type { DiagnosisPacket } from './model-diagnosis';
import { checkEvaluationIntegrity } from './evaluation-integrity';
import { HISTORY_PAGE_SIZE, predictionSelection } from './history-query';
import type { HistoryQuery } from './history-query';
import { postmatchPacketMatchesRecord } from './evidence-presentation';
import type {
  AiJobStatus,
  AnalysisPacket,
  ClassifiedFailure,
} from './ai-reliability';
import type {
  AiAnalysisJobPublic,
  AutomationHealth,
  AutomationSchedule,
  ChallengerPrediction,
  PostmatchAiReview,
  PostmatchModelDiagnosis,
  PredictionRecord,
  PredictionSnapshot,
  PrematchAiAnalysis,
  ProspectiveLearningState,
  PublicOverview,
  ResultEvidenceEnvelope,
} from './vct-types';

type PredictionRow = Record<string, unknown>;

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return `${value}`;
  return fallback;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? (JSON.parse(asString(value)) as T) : fallback;
  } catch {
    return fallback;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid_${field}`);
}

function fromRow(row: PredictionRow): PredictionSnapshot {
  return {
    id: asString(row.id),
    source: asString(row.source),
    modelVersion: asString(row.model_version),
    lockedAt: asString(row.locked_at),
    scheduledAt: asString(row.scheduled_at),
    event: asString(row.event),
    region: asString(row.region),
    patch: row.patch ? asString(row.patch) : null,
    seriesFormat: asString(row.series_format) as 'bo3' | 'bo5',
    teamA: asString(row.team_a),
    teamB: asString(row.team_b),
    teamAProbability: Number(row.team_a_probability),
    predictedScore: asString(row.predicted_score),
    status: asString(row.status) as 'locked' | 'resolved',
    actualWinner: row.actual_winner ? asString(row.actual_winner) : null,
    actualScore: row.actual_score ? asString(row.actual_score) : null,
    resolvedAt: row.resolved_at ? asString(row.resolved_at) : null,
    dataCutoffAt: asString(row.data_cutoff_at),
    factors: parseJson(row.factor_snapshot_json, []),
    maps: parseJson(row.map_probabilities_json, []),
    scoreDistribution: parseJson(row.score_distribution_json, {}),
    evidence: parseJson(
      row.evidence_json,
      fallbackOverview.prediction.evidence,
    ),
    resultEvidence: row.result_evidence_json
      ? parseJson(row.result_evidence_json, null)
      : null,
    scorecard: row.scorecard_json ? parseJson(row.scorecard_json, null) : null,
  };
}

function recordFromRow(row: PredictionRow): PredictionRecord {
  const record: PredictionRecord = {
    ...fromRow(row),
    prematchAiCreatedAt: row.prematch_ai_created_at
      ? asString(row.prematch_ai_created_at)
      : null,
    prematchAiModelId: row.prematch_ai_model_id
      ? asString(row.prematch_ai_model_id)
      : null,
    prematchAiStatus: row.prematch_ai_status
      ? asString(row.prematch_ai_status)
      : null,
    prematchAnalysis: row.prematch_ai_json
      ? parseJson<PrematchAiAnalysis | null>(row.prematch_ai_json, null)
      : null,
    postmatchAiStatus: row.postmatch_ai_status
      ? asString(row.postmatch_ai_status)
      : null,
    postmatchReview: row.postmatch_ai_json
      ? parseJson<PostmatchAiReview | null>(row.postmatch_ai_json, null)
      : null,
    resultCorrectionCount: Number(row.result_correction_count ?? 0),
  };
  const packet = parseJson<Record<string, unknown>>(
    row.prematch_packet_json,
    {},
  );
  record.prematchContext = validatedPrematchContext(
    packet.reader_context,
    record,
  );
  return record;
}

function aiJobFromRow(row: PredictionRow): AiAnalysisJobPublic & {
  analysisPacket: AnalysisPacket | DiagnosisPacket;
  lockToken: string | null;
} {
  return {
    id: asString(row.id),
    predictionId: asString(row.prediction_id),
    stage: asString(row.stage) as AiAnalysisJobPublic['stage'],
    provider: asString(row.provider),
    modelId: asString(row.model_id),
    promptVersion: asString(row.prompt_version),
    schemaVersion: asString(row.schema_version),
    status: asString(row.status) as AiJobStatus,
    attemptCount: Number(row.attempt_count),
    requestStartedAt: row.request_started_at
      ? asString(row.request_started_at)
      : null,
    requestCompletedAt: row.request_completed_at
      ? asString(row.request_completed_at)
      : null,
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    errorStage: row.error_stage ? asString(row.error_stage) : null,
    errorCode: row.error_code ? asString(row.error_code) : null,
    errorMessage: row.error_message ? asString(row.error_message) : null,
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    payloadBytes: row.payload_bytes == null ? null : Number(row.payload_bytes),
    lastRetryAt: row.last_retry_at ? asString(row.last_retry_at) : null,
    nextRetryAt: row.next_retry_at ? asString(row.next_retry_at) : null,
    rawEvidenceHash: asString(row.raw_evidence_hash),
    analysisPacketHash: asString(row.analysis_packet_hash),
    evidenceGrade: asString(row.evidence_grade) as 'A' | 'B' | 'C' | 'D',
    retryPolicyVersion: asString(row.retry_policy_version),
    analysisPacket: parseJson<AnalysisPacket>(
      row.analysis_packet_json,
      {} as AnalysisPacket,
    ),
    lockToken: row.lock_token ? asString(row.lock_token) : null,
  };
}

const predictionRecordSelect = `SELECT p.*,
  (SELECT analysis_packet_json FROM ai_analysis_jobs WHERE prediction_id=p.id AND stage='prematch'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS prematch_packet_json,
  (SELECT created_at FROM ai_analyses WHERE prediction_id=p.id AND stage='prematch' AND status='complete'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS prematch_ai_created_at,
  (SELECT model_id FROM ai_analyses WHERE prediction_id=p.id AND stage='prematch' AND status='complete'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS prematch_ai_model_id,
  COALESCE((SELECT status FROM ai_analysis_jobs WHERE prediction_id=p.id AND stage='prematch'
    ORDER BY datetime(created_at) DESC LIMIT 1),(SELECT status FROM ai_analyses WHERE prediction_id=p.id AND stage='prematch'
    ORDER BY datetime(created_at) DESC LIMIT 1)) AS prematch_ai_status,
  (SELECT output_json FROM ai_analyses WHERE prediction_id=p.id AND stage='prematch' AND status='complete'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS prematch_ai_json,
  COALESCE((SELECT status FROM ai_analysis_jobs WHERE prediction_id=p.id AND stage='postmatch'
    ORDER BY datetime(created_at) DESC LIMIT 1),(SELECT status FROM ai_analyses WHERE prediction_id=p.id AND stage='postmatch'
    ORDER BY datetime(created_at) DESC LIMIT 1)) AS postmatch_ai_status,
  (SELECT output_json FROM ai_analyses WHERE prediction_id=p.id AND stage='postmatch' AND status='complete'
    ORDER BY datetime(created_at) DESC LIMIT 1) AS postmatch_ai_json,
  (SELECT COUNT(*) FROM result_evidence_revisions WHERE prediction_id=p.id) AS result_correction_count
  FROM predictions p`;

export async function listPredictionRecords(
  limit = 100,
): Promise<PredictionRecord[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await env.DB.prepare(`${predictionRecordSelect}
    WHERE p.source LIKE 'system%'
    ORDER BY datetime(p.scheduled_at) DESC, p.id DESC LIMIT ?`)
    .bind(safeLimit)
    .all<PredictionRow>();
  return (result.results ?? []).map(recordFromRow);
}

export async function predictionsForDay(
  day: string,
  region = '',
): Promise<PredictionRecord[]> {
  const selection = predictionSelection({ day, region });
  const result =
    await env.DB.prepare(`${predictionRecordSelect} WHERE ${selection.where}
    ORDER BY datetime(p.scheduled_at) ASC, p.id ASC`)
      .bind(...selection.values)
      .all<PredictionRow>();
  return (result.results ?? []).map(recordFromRow);
}

export async function predictionHistoryPage(
  requestedPage = 1,
  query: HistoryQuery = {},
) {
  const selection = predictionSelection(query);
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM predictions p WHERE ${selection.where}`,
  )
    .bind(...selection.values)
    .first<{ total: number }>();
  const total = Number(count?.total ?? 0),
    pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const page = Math.min(
    pages,
    Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1),
  );
  const sort = query.resolvedOnly ? 'p.resolved_at' : 'p.scheduled_at';
  const result =
    await env.DB.prepare(`${predictionRecordSelect} WHERE ${selection.where}
    ORDER BY datetime(${sort}) DESC, p.id DESC LIMIT ? OFFSET ?`)
      .bind(
        ...selection.values,
        HISTORY_PAGE_SIZE,
        (page - 1) * HISTORY_PAGE_SIZE,
      )
      .all<PredictionRow>();
  return {
    records: (result.results ?? []).map(recordFromRow),
    page,
    pages,
    total,
    pageSize: HISTORY_PAGE_SIZE,
  };
}

export async function predictionRecordById(
  id: string,
): Promise<PredictionRecord | null> {
  const row = await env.DB.prepare(
    `${predictionRecordSelect} WHERE p.id=? AND p.source LIKE 'system%' LIMIT 1`,
  )
    .bind(id)
    .first<PredictionRow>();
  if (!row) return null;
  const record = recordFromRow(row);
  record.challenger = await challengerByChampion(env.DB, id);
  record.postmatchJob = await latestAiJob(env.DB, id, 'postmatch');
  const savedJob =
    await env.DB.prepare(`SELECT j.analysis_packet_json,a.output_json FROM ai_analysis_jobs j
    JOIN ai_analyses a ON a.id=j.output_analysis_id AND a.prediction_id=j.prediction_id AND a.stage=j.stage AND a.status='complete'
    WHERE j.prediction_id=? AND j.stage='postmatch' AND j.status='SUCCESS' ORDER BY datetime(j.created_at) DESC LIMIT 1`)
      .bind(id)
      .first<PredictionRow>();
  const packet = parseJson<AnalysisPacket | null>(
    savedJob?.analysis_packet_json,
    null,
  );
  // Only expose the actual packet bound to the displayed immutable AI output.
  // Stale result-revision packets and legacy outputs have no verified packet.
  record.postmatchEvidence =
    packet &&
    sameJson(parseJson(savedJob?.output_json, null), record.postmatchReview) &&
    postmatchPacketMatchesRecord(packet, record)
      ? packet
      : null;
  return record;
}

export async function listPostmatchReviewRecords(
  limit = 100,
): Promise<PredictionRecord[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await env.DB.prepare(`${predictionRecordSelect}
    WHERE p.status='resolved' AND p.source LIKE 'system%' ORDER BY datetime(p.resolved_at) DESC, p.id DESC LIMIT ?`)
    .bind(safeLimit)
    .all<PredictionRow>();
  return (result.results ?? []).map(recordFromRow);
}

// Read-only view over existing ledgers. No backfill, fitting or result mutation.
export async function listModelComparisonRecords(): Promise<
  PredictionRecord[]
> {
  const [predictions, challengers] = await Promise.all([
    env.DB.prepare(`${predictionRecordSelect} WHERE p.source LIKE 'system%'
      ORDER BY datetime(p.scheduled_at) DESC, p.id DESC`).all<PredictionRow>(),
    env.DB.prepare('SELECT * FROM challenger_predictions WHERE record_kind=?')
      .bind('real_prospective')
      .all<PredictionRow>(),
  ]);
  const pairs = new Map(
    (challengers.results ?? []).map((row) => {
      const item = challengerFromRow(row);
      return [item.championPredictionId, item] as const;
    }),
  );
  return (predictions.results ?? []).map((row) => {
    const record = recordFromRow(row);
    record.challenger = pairs.get(record.id) ?? null;
    return record;
  });
}

export function validatePrediction(value: unknown): PredictionSnapshot {
  if (!value || typeof value !== 'object')
    throw new Error('prediction_required');
  const item = value as PredictionSnapshot;
  const required = [
    'id',
    'source',
    'modelVersion',
    'lockedAt',
    'scheduledAt',
    'event',
    'region',
    'seriesFormat',
    'teamA',
    'teamB',
    'predictedScore',
    'dataCutoffAt',
  ] as const;
  for (const key of required) if (!item[key]) throw new Error(`missing_${key}`);
  if (!['bo3', 'bo5'].includes(item.seriesFormat))
    throw new Error('invalid_series_format');
  if (item.status !== 'locked') throw new Error('prediction_must_be_locked');
  if (!(item.teamAProbability > 0 && item.teamAProbability < 1))
    throw new Error('invalid_probability');
  assertIsoTimestamp(item.lockedAt, 'locked_at');
  assertIsoTimestamp(item.scheduledAt, 'scheduled_at');
  assertIsoTimestamp(item.dataCutoffAt, 'data_cutoff_at');
  if (Date.parse(item.lockedAt) > Date.parse(item.scheduledAt))
    throw new Error('locked_after_scheduled');
  if (Date.parse(item.dataCutoffAt) > Date.parse(item.lockedAt))
    throw new Error('data_cutoff_after_lock');
  if (!Array.isArray(item.factors) || !Array.isArray(item.maps))
    throw new Error('missing_explanation_snapshot');
  for (const factor of item.factors) {
    if (
      !factor.key ||
      !factor.label ||
      !Number.isFinite(factor.probabilityPoints) ||
      !Number.isFinite(factor.absoluteShare)
    ) {
      throw new Error('invalid_factor_snapshot');
    }
  }
  for (const map of item.maps) {
    if (
      !map.map ||
      !(map.teamAProbability > 0 && map.teamAProbability < 1) ||
      Math.abs(map.teamAProbability + map.teamBProbability - 1) > 0.001
    ) {
      throw new Error('invalid_map_snapshot');
    }
  }
  const scoreProbabilities = Object.values(item.scoreDistribution);
  const scoreTotal = scoreProbabilities.reduce(
    (sum, probability) => sum + probability,
    0,
  );
  if (
    scoreProbabilities.length > 0 &&
    (!Number.isFinite(scoreTotal) || Math.abs(scoreTotal - 1) > 0.01)
  ) {
    throw new Error('invalid_score_distribution');
  }
  if (scoreProbabilities.length === 0 && item.source.startsWith('system'))
    throw new Error('missing_system_score_distribution');
  return item;
}

export async function upsertPrediction(
  db: D1Database,
  prediction: PredictionSnapshot,
  syncRunId?: string | null,
): Promise<void> {
  const existing = await predictionById(db, prediction.id);
  if (existing) {
    const immutableMatches =
      existing.source === prediction.source &&
      existing.modelVersion === prediction.modelVersion &&
      existing.lockedAt === prediction.lockedAt &&
      existing.scheduledAt === prediction.scheduledAt &&
      existing.event === prediction.event &&
      existing.region === prediction.region &&
      existing.patch === prediction.patch &&
      existing.seriesFormat === prediction.seriesFormat &&
      existing.teamA === prediction.teamA &&
      existing.teamB === prediction.teamB &&
      Math.abs(existing.teamAProbability - prediction.teamAProbability) <
        1e-12 &&
      existing.predictedScore === prediction.predictedScore &&
      existing.dataCutoffAt === prediction.dataCutoffAt &&
      sameJson(existing.factors, prediction.factors) &&
      sameFrozenMapSnapshot(existing.maps, prediction.maps) &&
      sameJson(existing.scoreDistribution, prediction.scoreDistribution) &&
      sameJson(existing.evidence, prediction.evidence);
    if (!immutableMatches) throw new Error('prediction_snapshot_conflict');
    if (syncRunId) {
      await db
        .prepare(
          'UPDATE predictions SET last_sync_run_id=?,updated_at=? WHERE id=?',
        )
        .bind(syncRunId, new Date().toISOString(), prediction.id)
        .run();
    }
    return;
  }
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT INTO predictions (
    id, source, model_version, locked_at, scheduled_at, event, region, patch, series_format, team_a, team_b,
    team_a_probability, predicted_score, status, actual_winner, actual_score, resolved_at, data_cutoff_at,
    factor_snapshot_json, map_probabilities_json, score_distribution_json, evidence_json, last_sync_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status=excluded.status, actual_winner=COALESCE(excluded.actual_winner, predictions.actual_winner),
    actual_score=COALESCE(excluded.actual_score, predictions.actual_score), resolved_at=COALESCE(excluded.resolved_at, predictions.resolved_at),
    updated_at=excluded.updated_at`)
    .bind(
      prediction.id,
      prediction.source,
      prediction.modelVersion,
      prediction.lockedAt,
      prediction.scheduledAt,
      prediction.event,
      prediction.region,
      prediction.patch ?? null,
      prediction.seriesFormat,
      prediction.teamA,
      prediction.teamB,
      prediction.teamAProbability,
      prediction.predictedScore,
      prediction.status,
      prediction.actualWinner ?? null,
      prediction.actualScore ?? null,
      prediction.resolvedAt ?? null,
      prediction.dataCutoffAt,
      JSON.stringify(prediction.factors),
      JSON.stringify(prediction.maps),
      JSON.stringify(prediction.scoreDistribution),
      JSON.stringify(prediction.evidence),
      syncRunId ?? null,
      now,
      now,
    )
    .run();
}

export async function latestPrediction(
  db: D1Database,
): Promise<PredictionSnapshot | null> {
  const row = await db
    .prepare(
      "SELECT * FROM predictions WHERE source LIKE 'system%' ORDER BY datetime(scheduled_at) DESC LIMIT 1",
    )
    .first<PredictionRow>();
  return row ? fromRow(row) : null;
}

export async function predictionById(
  db: D1Database,
  id: string,
): Promise<PredictionSnapshot | null> {
  const row = await db
    .prepare('SELECT * FROM predictions WHERE id = ? LIMIT 1')
    .bind(id)
    .first<PredictionRow>();
  return row ? fromRow(row) : null;
}

async function isArchivedResultRedelivery(
  db: D1Database,
  predictionId: string,
  winner: string,
  score: string,
  resultEvidence: ResultEvidenceEnvelope,
): Promise<boolean> {
  const revisions = await db
    .prepare(`SELECT previous_winner,previous_score,previous_result_evidence_json
    FROM result_evidence_revisions WHERE prediction_id=? ORDER BY revision_no DESC`)
    .bind(predictionId)
    .all<PredictionRow>();
  return (revisions.results ?? []).some((revision) =>
    matchesArchivedResultDelivery(
      {
        winner: revision.previous_winner
          ? asString(revision.previous_winner)
          : null,
        score: revision.previous_score
          ? asString(revision.previous_score)
          : null,
        evidence: revision.previous_result_evidence_json
          ? parseJson<ResultEvidenceEnvelope | null>(
              revision.previous_result_evidence_json,
              null,
            )
          : null,
      },
      { winner, score, evidence: resultEvidence },
    ),
  );
}

export async function resolvePrediction(
  db: D1Database,
  id: string,
  winner: string,
  score: string,
  resolvedAt: string,
  resultEvidence: ResultEvidenceEnvelope,
  syncRunId?: string | null,
): Promise<PredictionSnapshot> {
  const existing = await predictionById(db, id);
  if (!existing) throw new Error('prediction_not_found');
  validateActualScore(existing, winner, score);
  validateResultEvidence(existing, winner, score, resultEvidence);
  assertIsoTimestamp(resolvedAt, 'resolved_at');
  if (Date.parse(resolvedAt) < Date.parse(existing.scheduledAt))
    throw new Error('resolved_before_scheduled');
  if (resolvedAt !== resultEvidence.source.capturedAt)
    throw new Error('result_observation_time_conflict');
  const scorecard = computePostmatchScorecard(existing, winner, score);
  if (existing.status === 'resolved') {
    if (
      (existing.actualWinner !== winner ||
        existing.actualScore !== score ||
        (existing.resultEvidence &&
          !sameFrozenResultEvidence(
            existing.resultEvidence,
            resultEvidence,
          ))) &&
      (await isArchivedResultRedelivery(db, id, winner, score, resultEvidence))
    ) {
      if (syncRunId) {
        await db
          .prepare(
            'UPDATE predictions SET last_sync_run_id=?,updated_at=? WHERE id=?',
          )
          .bind(syncRunId, new Date().toISOString(), id)
          .run();
      }
      return existing;
    }
    if (existing.actualWinner !== winner || existing.actualScore !== score)
      throw new Error('result_conflict');
    if (
      existing.resultEvidence &&
      !sameFrozenResultEvidence(existing.resultEvidence, resultEvidence)
    )
      throw new Error('result_evidence_conflict');
    if (existing.scorecard && !sameJson(existing.scorecard, scorecard))
      throw new Error('scorecard_conflict');
    if (!existing.resultEvidence || !existing.scorecard || syncRunId) {
      await db
        .prepare(`UPDATE predictions SET result_evidence_version=COALESCE(result_evidence_version,?),
        result_evidence_json=COALESCE(result_evidence_json,?),scorecard_version=COALESCE(scorecard_version,?),
        scorecard_json=COALESCE(scorecard_json,?),last_sync_run_id=COALESCE(?,last_sync_run_id),updated_at=? WHERE id=?`)
        .bind(
          resultEvidence.schemaVersion,
          JSON.stringify(resultEvidence),
          scorecard.schemaVersion,
          JSON.stringify(scorecard),
          syncRunId ?? null,
          new Date().toISOString(),
          id,
        )
        .run();
    }
    return {
      ...existing,
      resultEvidence: existing.resultEvidence ?? resultEvidence,
      scorecard: existing.scorecard ?? scorecard,
    };
  }
  const resolved = {
    ...existing,
    status: 'resolved' as const,
    actualWinner: winner,
    actualScore: score,
    resolvedAt,
    resultEvidence,
    scorecard,
  };
  await db
    .prepare(`UPDATE predictions SET status='resolved',actual_winner=?,actual_score=?,resolved_at=?,
    result_evidence_version=?,result_evidence_json=?,scorecard_version=?,scorecard_json=?,last_sync_run_id=?,updated_at=?
    WHERE id=? AND status='locked'`)
    .bind(
      winner,
      score,
      resolvedAt,
      resultEvidence.schemaVersion,
      JSON.stringify(resultEvidence),
      scorecard.schemaVersion,
      JSON.stringify(scorecard),
      syncRunId ?? null,
      new Date().toISOString(),
      id,
    )
    .run();
  return resolved;
}

export async function correctPredictionResult(
  db: D1Database,
  id: string,
  winner: string,
  score: string,
  resolvedAt: string,
  resultEvidence: ResultEvidenceEnvelope,
  reason: 'SOURCE_PAGE_STABILIZED_AFTER_PREMATURE_CAPTURE',
): Promise<{ prediction: PredictionSnapshot; revisionNo: number }> {
  if (reason !== 'SOURCE_PAGE_STABILIZED_AFTER_PREMATURE_CAPTURE')
    throw new Error('invalid_result_correction_reason');
  const existing = await predictionById(db, id);
  if (!existing) throw new Error('prediction_not_found');
  validateResultCorrection(existing, winner, score, resultEvidence);
  assertIsoTimestamp(resolvedAt, 'resolved_at');
  if (resolvedAt !== resultEvidence.source.capturedAt)
    throw new Error('result_observation_time_conflict');
  const scorecard = computePostmatchScorecard(existing, winner, score);
  const revisionRow = await db
    .prepare(
      'SELECT COALESCE(MAX(revision_no),0) AS revision_no FROM result_evidence_revisions WHERE prediction_id=?',
    )
    .bind(id)
    .first<PredictionRow>();
  const revisionNo = Number(revisionRow?.revision_no ?? 0) + 1;
  const now = new Date().toISOString();
  const previousEvidenceHash = await sha256(existing.resultEvidence);
  const correctedEvidenceHash = await sha256(resultEvidence);
  await db.batch([
    db
      .prepare(`INSERT INTO result_evidence_revisions(
      id,prediction_id,revision_no,reason,previous_winner,previous_score,previous_resolved_at,previous_result_evidence_json,
      previous_scorecard_json,previous_evidence_hash,corrected_winner,corrected_score,corrected_resolved_at,
      corrected_result_evidence_json,corrected_scorecard_json,corrected_evidence_hash,source_url,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        crypto.randomUUID(),
        id,
        revisionNo,
        reason,
        existing.actualWinner,
        existing.actualScore,
        existing.resolvedAt,
        JSON.stringify(existing.resultEvidence),
        JSON.stringify(existing.scorecard),
        previousEvidenceHash,
        winner,
        score,
        resolvedAt,
        JSON.stringify(resultEvidence),
        JSON.stringify(scorecard),
        correctedEvidenceHash,
        resultEvidence.source.sourceUrl ?? null,
        now,
      ),
    db
      .prepare(`UPDATE predictions SET actual_winner=?,actual_score=?,resolved_at=?,result_evidence_version=?,result_evidence_json=?,
      scorecard_version=?,scorecard_json=?,updated_at=? WHERE id=? AND status='resolved'`)
      .bind(
        winner,
        score,
        resolvedAt,
        resultEvidence.schemaVersion,
        JSON.stringify(resultEvidence),
        scorecard.schemaVersion,
        JSON.stringify(scorecard),
        now,
        id,
      ),
  ]);
  return {
    prediction: {
      ...existing,
      actualWinner: winner,
      actualScore: score,
      resolvedAt,
      resultEvidence,
      scorecard,
    },
    revisionNo,
  };
}

function challengerFromRow(row: PredictionRow): ChallengerPrediction {
  return {
    id: asString(row.id),
    fixtureId: asString(row.fixture_id),
    championPredictionId: asString(row.champion_prediction_id),
    featureSnapshotId: asString(row.feature_snapshot_id),
    featureSnapshotHash: asString(row.feature_snapshot_hash),
    features: parseJson(row.feature_json, {}),
    featureStatus: parseJson(row.feature_status_json, {}),
    evidence: parseJson(row.evidence_json, {}),
    frozenAt: asString(row.frozen_at),
    scheduledAt: asString(row.scheduled_at),
    championModelVersion: asString(row.champion_model_version),
    championProbability: Number(row.champion_probability),
    challengerModelId: asString(row.challenger_model_id),
    datasetVersion: asString(row.dataset_version),
    artifactHash: asString(row.artifact_hash),
    challengerProbability: Number(row.challenger_probability),
    probabilityDelta: Number(row.probability_delta),
    dataQualityState: asString(row.data_quality_state),
    recordKind: asString(row.record_kind) as ChallengerPrediction['recordKind'],
    eligible: Boolean(row.eligible),
    status: asString(row.status) as ChallengerPrediction['status'],
    actualWinner: row.actual_winner ? asString(row.actual_winner) : null,
    resolvedAt: row.resolved_at ? asString(row.resolved_at) : null,
    championBrier:
      row.champion_brier == null ? null : Number(row.champion_brier),
    challengerBrier:
      row.challenger_brier == null ? null : Number(row.challenger_brier),
    championLogLoss:
      row.champion_log_loss == null ? null : Number(row.champion_log_loss),
    challengerLogLoss:
      row.challenger_log_loss == null ? null : Number(row.challenger_log_loss),
    championCorrect:
      row.champion_correct == null ? null : Boolean(row.champion_correct),
    challengerCorrect:
      row.challenger_correct == null ? null : Boolean(row.challenger_correct),
  };
}

export function validateChallengerPrediction(
  value: unknown,
): ChallengerPrediction {
  if (!value || typeof value !== 'object')
    throw new Error('challenger_prediction_required');
  const item = value as ChallengerPrediction;
  for (const key of [
    'id',
    'fixtureId',
    'championPredictionId',
    'featureSnapshotId',
    'featureSnapshotHash',
    'frozenAt',
    'scheduledAt',
    'championModelVersion',
    'challengerModelId',
    'datasetVersion',
    'artifactHash',
    'dataQualityState',
    'recordKind',
    'status',
  ] as const) {
    if (!item[key]) throw new Error(`missing_challenger_${key}`);
  }
  assertIsoTimestamp(item.frozenAt, 'challenger_frozen_at');
  assertIsoTimestamp(item.scheduledAt, 'challenger_scheduled_at');
  if (Date.parse(item.frozenAt) >= Date.parse(item.scheduledAt))
    throw new Error('challenger_not_frozen_prematch');
  if (
    ![item.championProbability, item.challengerProbability].every(
      (number) => Number.isFinite(number) && number >= 0 && number <= 1,
    )
  )
    throw new Error('invalid_challenger_probability');
  if (
    Math.abs(
      item.probabilityDelta -
        (item.challengerProbability - item.championProbability),
    ) > 1e-9
  )
    throw new Error('invalid_probability_delta');
  if (
    !['real_prospective', 'isolated_test'].includes(item.recordKind) ||
    !['locked', 'resolved'].includes(item.status)
  )
    throw new Error('invalid_challenger_state');
  if (!item.features || !item.featureStatus || !item.evidence)
    throw new Error('missing_challenger_snapshot');
  return item;
}

export async function challengerByChampion(
  db: D1Database,
  championPredictionId: string,
): Promise<ChallengerPrediction | null> {
  const row = await db
    .prepare(
      'SELECT * FROM challenger_predictions WHERE champion_prediction_id=? LIMIT 1',
    )
    .bind(championPredictionId)
    .first<PredictionRow>();
  return row ? challengerFromRow(row) : null;
}

export async function upsertChallengerPrediction(
  db: D1Database,
  item: ChallengerPrediction,
  syncRunId?: string | null,
): Promise<void> {
  const existing = await challengerByChampion(db, item.championPredictionId);
  if (existing) {
    const immutableMatches =
      existing.id === item.id &&
      existing.fixtureId === item.fixtureId &&
      existing.featureSnapshotId === item.featureSnapshotId &&
      existing.featureSnapshotHash === item.featureSnapshotHash &&
      existing.frozenAt === item.frozenAt &&
      existing.scheduledAt === item.scheduledAt &&
      existing.championModelVersion === item.championModelVersion &&
      Math.abs(existing.championProbability - item.championProbability) <
        1e-12 &&
      existing.challengerModelId === item.challengerModelId &&
      existing.datasetVersion === item.datasetVersion &&
      existing.artifactHash === item.artifactHash &&
      Math.abs(existing.challengerProbability - item.challengerProbability) <
        1e-12 &&
      Math.abs(existing.probabilityDelta - item.probabilityDelta) < 1e-12 &&
      existing.dataQualityState === item.dataQualityState &&
      existing.recordKind === item.recordKind &&
      existing.eligible === item.eligible &&
      sameJson(existing.features, item.features) &&
      sameJson(existing.featureStatus, item.featureStatus) &&
      sameJson(existing.evidence, item.evidence);
    if (!immutableMatches) throw new Error('challenger_snapshot_conflict');
    if (syncRunId) {
      await db
        .prepare(
          'UPDATE challenger_predictions SET last_sync_run_id=?,updated_at=? WHERE id=?',
        )
        .bind(syncRunId, new Date().toISOString(), existing.id)
        .run();
    }
    return;
  }
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT INTO challenger_predictions(id,fixture_id,champion_prediction_id,feature_snapshot_id,feature_snapshot_hash,
    feature_json,feature_status_json,evidence_json,frozen_at,scheduled_at,champion_model_version,champion_probability,
    challenger_model_id,dataset_version,artifact_hash,challenger_probability,probability_delta,data_quality_state,record_kind,
    eligible,status,last_sync_run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      item.id,
      item.fixtureId,
      item.championPredictionId,
      item.featureSnapshotId,
      item.featureSnapshotHash,
      JSON.stringify(item.features),
      JSON.stringify(item.featureStatus),
      JSON.stringify(item.evidence),
      item.frozenAt,
      item.scheduledAt,
      item.championModelVersion,
      item.championProbability,
      item.challengerModelId,
      item.datasetVersion,
      item.artifactHash,
      item.challengerProbability,
      item.probabilityDelta,
      item.dataQualityState,
      item.recordKind,
      item.eligible ? 1 : 0,
      'locked',
      syncRunId ?? null,
      now,
      now,
    )
    .run();
}

export async function resolveChallenger(
  db: D1Database,
  champion: PredictionSnapshot,
  winner: string,
  resolvedAt: string,
  syncRunId?: string | null,
): Promise<ChallengerPrediction | null> {
  const existing = await challengerByChampion(db, champion.id);
  if (!existing) return null;
  if (existing.status === 'resolved') {
    if (existing.actualWinner !== winner)
      throw new Error('challenger_result_conflict');
    if (syncRunId)
      await db
        .prepare(
          'UPDATE challenger_predictions SET last_sync_run_id=?,updated_at=? WHERE id=?',
        )
        .bind(syncRunId, new Date().toISOString(), existing.id)
        .run();
    return existing;
  }
  const outcome = winner === champion.teamA ? 1 : 0;
  const score = (probability: number) =>
    -Math.log(
      Math.min(
        Math.max(outcome ? probability : 1 - probability, 1e-15),
        1 - 1e-15,
      ),
    );
  const championCorrect =
    existing.championProbability >= 0.5 === Boolean(outcome);
  const challengerCorrect =
    existing.challengerProbability >= 0.5 === Boolean(outcome);
  await db
    .prepare(`UPDATE challenger_predictions SET status='resolved',actual_winner=?,resolved_at=?,champion_brier=?,challenger_brier=?,
    champion_log_loss=?,challenger_log_loss=?,champion_correct=?,challenger_correct=?,last_sync_run_id=?,updated_at=? WHERE id=? AND status='locked'`)
    .bind(
      winner,
      resolvedAt,
      (existing.championProbability - outcome) ** 2,
      (existing.challengerProbability - outcome) ** 2,
      score(existing.championProbability),
      score(existing.challengerProbability),
      championCorrect ? 1 : 0,
      challengerCorrect ? 1 : 0,
      syncRunId ?? null,
      new Date().toISOString(),
      existing.id,
    )
    .run();
  return challengerByChampion(db, champion.id);
}

export async function correctResolvedChallenger(
  db: D1Database,
  champion: PredictionSnapshot,
  winner: string,
  resolvedAt: string,
): Promise<ChallengerPrediction | null> {
  const existing = await challengerByChampion(db, champion.id);
  if (!existing) return null;
  if (existing.status !== 'resolved')
    return resolveChallenger(db, champion, winner, resolvedAt);
  const outcome = winner === champion.teamA ? 1 : 0;
  const logLoss = (probability: number) =>
    -Math.log(
      Math.min(
        Math.max(outcome ? probability : 1 - probability, 1e-15),
        1 - 1e-15,
      ),
    );
  await db
    .prepare(`UPDATE challenger_predictions SET actual_winner=?,resolved_at=?,champion_brier=?,challenger_brier=?,
    champion_log_loss=?,challenger_log_loss=?,champion_correct=?,challenger_correct=?,updated_at=? WHERE id=? AND status='resolved'`)
    .bind(
      winner,
      resolvedAt,
      (existing.championProbability - outcome) ** 2,
      (existing.challengerProbability - outcome) ** 2,
      logLoss(existing.championProbability),
      logLoss(existing.challengerProbability),
      existing.championProbability >= 0.5 === Boolean(outcome) ? 1 : 0,
      existing.challengerProbability >= 0.5 === Boolean(outcome) ? 1 : 0,
      new Date().toISOString(),
      existing.id,
    )
    .run();
  return challengerByChampion(db, champion.id);
}

export async function saveModelDiagnosis(
  db: D1Database,
  input: {
    challenger: ChallengerPrediction;
    modelId: string;
    promptVersion: string;
    status: string;
    result: object;
    output?: PostmatchModelDiagnosis;
    errorCode?: string;
  },
): Promise<void> {
  await modelDiagnosisStatement(db, input).run();
}

function modelDiagnosisStatement(
  db: D1Database,
  input: {
    challenger: ChallengerPrediction;
    modelId: string;
    promptVersion: string;
    status: string;
    result: object;
    output?: PostmatchModelDiagnosis;
    errorCode?: string;
    id?: string;
    createdAt?: string;
  },
) {
  return db
    .prepare(`INSERT INTO challenger_diagnoses(id,challenger_prediction_id,champion_prediction_id,created_at,provider,model_id,
    prompt_version,schema_version,status,result_json,facts_json,model_signals_json,hypotheses_json,tags_json,research_hypothesis,
    evidence_references_json,confidence,error_code,direct_model_control_allowed) VALUES(?,?,?,?,'deepseek',?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
    .bind(
      input.id ?? crypto.randomUUID(),
      input.challenger.id,
      input.challenger.championPredictionId,
      input.createdAt ?? new Date().toISOString(),
      input.modelId,
      input.promptVersion,
      input.promptVersion === DIAGNOSIS_JOB_PROMPT_VERSION
        ? DIAGNOSIS_JOB_SCHEMA_VERSION
        : 'v1.4c-r1-diagnosis-v2',
      input.status,
      JSON.stringify(input.result),
      input.output ? JSON.stringify(input.output.facts) : null,
      input.output ? JSON.stringify(input.output.model_signals) : null,
      input.output ? JSON.stringify(input.output.hypotheses) : null,
      input.output ? JSON.stringify(input.output.diagnostic_tags) : null,
      input.output?.research_hypothesis ?? null,
      input.output
        ? JSON.stringify([
            ...new Set(
              [
                ...input.output.facts,
                ...input.output.model_signals,
                ...input.output.hypotheses,
              ].flatMap((entry) => entry.evidence_ids),
            ),
          ])
        : null,
      input.output?.confidence ?? null,
      input.errorCode ?? null,
    );
}

export async function latestModelDiagnosisStatus(
  db: D1Database,
  challengerPredictionId: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT status FROM challenger_diagnoses WHERE challenger_prediction_id=?
    ORDER BY datetime(created_at) DESC LIMIT 1`)
    .bind(challengerPredictionId)
    .first<PredictionRow>();
  return row ? asString(row.status) : null;
}

export async function aggregatedDiagnosisTags(
  db: D1Database,
  minimumSample = 10,
): Promise<{
  status: 'READY' | 'INSUFFICIENT_SAMPLE';
  resolvedDiagnoses: number;
  minimumSample: number;
  tags: Record<string, number>;
}> {
  const rows = await db
    .prepare(`SELECT tags_json FROM challenger_diagnoses d
    JOIN challenger_predictions c ON c.id=d.challenger_prediction_id
    WHERE d.status='complete' AND c.status='resolved' ORDER BY datetime(d.created_at)`)
    .all<PredictionRow>();
  const results = rows.results ?? [];
  if (results.length < minimumSample)
    return {
      status: 'INSUFFICIENT_SAMPLE',
      resolvedDiagnoses: results.length,
      minimumSample,
      tags: {},
    };
  const tags: Record<string, number> = {};
  for (const row of results)
    for (const tag of parseJson<string[]>(row.tags_json, []))
      tags[tag] = (tags[tag] ?? 0) + 1;
  return {
    status: 'READY',
    resolvedDiagnoses: results.length,
    minimumSample,
    tags,
  };
}

export async function latestAiAnalysisStatus(
  db: D1Database,
  predictionId: string,
  stage: 'prematch' | 'postmatch',
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT status FROM ai_analyses WHERE prediction_id=? AND stage=? AND status!='diagnostic'
    ORDER BY datetime(created_at) DESC LIMIT 1`)
    .bind(predictionId, stage)
    .first<Record<string, unknown>>();
  return row ? asString(row.status) : null;
}

export async function failedAiAnalysisCount(
  db: D1Database,
  predictionId: string,
  stage: 'prematch' | 'postmatch',
  promptVersion: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ai_analyses
    WHERE prediction_id=? AND stage=? AND prompt_version=? AND status='failed'`)
    .bind(predictionId, stage, promptVersion)
    .first<Record<string, unknown>>();
  return Number(row?.count ?? 0);
}

export async function saveAiAnalysis(
  db: D1Database,
  input: {
    predictionId: string;
    stage: 'prematch' | 'postmatch';
    modelId: string;
    promptVersion: string;
    status: string;
    output?: object;
    errorCode?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO ai_analyses (
    id, prediction_id, stage, provider, model_id, prompt_version, status, output_json, error_code, direct_promotion_allowed, created_at
  ) VALUES (?, ?, ?, 'deepseek', ?, ?, ?, ?, ?, 0, ?)`)
    .bind(
      id,
      input.predictionId,
      input.stage,
      input.modelId,
      input.promptVersion,
      input.status,
      input.output ? JSON.stringify(input.output) : null,
      input.errorCode ?? null,
      new Date().toISOString(),
    )
    .run();
  return id;
}

export async function latestAiJob(
  db: D1Database,
  predictionId: string,
  stage: AiAnalysisJobPublic['stage'],
) {
  const row = await db
    .prepare(`SELECT * FROM ai_analysis_jobs WHERE prediction_id=? AND stage=?
    ORDER BY datetime(created_at) DESC LIMIT 1`)
    .bind(predictionId, stage)
    .first<PredictionRow>();
  return row ? aiJobFromRow(row) : null;
}

export async function ensurePostmatchAiJob(
  db: D1Database,
  prediction: PredictionSnapshot,
  modelId: string,
  versions: { promptVersion?: string; schemaVersion?: string } = {},
): Promise<{
  created: boolean;
  job: ReturnType<typeof aiJobFromRow> | { status: 'SUCCESS' };
}> {
  if (prediction.source && !prediction.source.startsWith('system'))
    throw new Error('ai_job_system_prediction_required');
  if (
    prediction.status !== 'resolved' ||
    !prediction.resultEvidence ||
    !prediction.scorecard
  )
    throw new Error('ai_job_resolved_evidence_required');
  // A prompt upgrade is not permission to regenerate historical analyses.
  // Explicit, versioned result-correction requests still create their own job.
  if (!versions.promptVersion && !versions.schemaVersion) {
    const prior = await latestAiJob(db, prediction.id, 'postmatch');
    if (prior) return { created: false, job: prior };
    const completed = await db
      .prepare(
        "SELECT id FROM ai_analyses WHERE prediction_id=? AND stage='postmatch' AND status='complete' LIMIT 1",
      )
      .bind(prediction.id)
      .first();
    if (completed) return { created: false, job: { status: 'SUCCESS' } };
  }
  const promptVersion = versions.promptVersion ?? POSTMATCH_JOB_PROMPT_VERSION;
  const schemaVersion = versions.schemaVersion ?? POSTMATCH_JOB_SCHEMA_VERSION;
  const logicalKey = logicalJobKey(
    prediction.id,
    'postmatch',
    promptVersion,
    schemaVersion,
  );
  const existing = await db
    .prepare('SELECT * FROM ai_analysis_jobs WHERE logical_key=? LIMIT 1')
    .bind(logicalKey)
    .first<PredictionRow>();
  if (existing) return { created: false, job: aiJobFromRow(existing) };
  const hashed = await packetWithHashes(prediction);
  if (
    schemaVersion !== POSTMATCH_JOB_SCHEMA_VERSION &&
    schemaVersion !== 'v1.4c-reader2-postmatch-analysis-v11' &&
    schemaVersion !== EDITORIAL_REVIEW_SCHEMA
  ) {
    delete hashed.packet.readerInsights;
    hashed.packet.evidenceReferences = hashed.packet.evidenceReferences.filter(
      (id) => !id.startsWith('fact:reader-player:'),
    );
    hashed.analysisPacketHash = await sha256(hashed.packet);
  }
  if (schemaVersion === 'v1.4c-r2-postmatch-analysis-v1') {
    delete hashed.packet.reviewFocus;
    delete hashed.packet.teamOutcomes;
    hashed.analysisPacketHash = await sha256(hashed.packet);
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO ai_analysis_jobs(
    id,logical_key,prediction_id,stage,provider,model_id,prompt_version,schema_version,status,retry_policy_version,attempt_count,
    next_retry_at,raw_evidence_hash,analysis_packet_hash,evidence_grade,analysis_packet_json,created_at,updated_at
  ) VALUES(?,? ,?,'postmatch','deepseek',?,?,?,'PENDING',?,0,?,?,?,?,?,?,?) ON CONFLICT(logical_key) DO NOTHING`)
    .bind(
      id,
      logicalKey,
      prediction.id,
      modelId,
      promptVersion,
      schemaVersion,
      RETRY_POLICY_VERSION,
      now,
      hashed.rawEvidenceHash,
      hashed.analysisPacketHash,
      hashed.packet.evidenceGrade,
      JSON.stringify(hashed.packet),
      now,
      now,
    )
    .run();
  const row = await db
    .prepare('SELECT * FROM ai_analysis_jobs WHERE logical_key=? LIMIT 1')
    .bind(logicalKey)
    .first<PredictionRow>();
  if (!row) throw new Error('ai_job_insert_failed');
  return { created: asString(row.id) === id, job: aiJobFromRow(row) };
}

export async function refreshReaderReview(
  db: D1Database,
  prediction: PredictionSnapshot,
  modelId: string,
) {
  // Never infer permission from a deployment or a page view. Called only by the
  // authenticated explicit single-record refresh action, not reconciliation.
  const result = await ensurePostmatchAiJob(db, prediction, modelId, {
    promptVersion: POSTMATCH_JOB_PROMPT_VERSION,
    schemaVersion: POSTMATCH_JOB_SCHEMA_VERSION,
  });
  // Explicit authenticated refresh after a transport fix may resume the same
  // timed-out reader job. Never reset attempts, replace its frozen packet, or
  // reopen terminal jobs. Ordinary reconciliation still respects backoff.
  if (
    !result.created &&
    'attemptCount' in result.job &&
    result.job.status === 'RETRY_SCHEDULED' &&
    result.job.attemptCount >= 2 &&
    result.job.errorCode === 'TIMEOUT_CONNECTION' &&
    result.job.nextRetryAt &&
    Date.parse(result.job.nextRetryAt) > Date.now()
  ) {
    const now = new Date().toISOString();
    await db
      .prepare(
        "UPDATE ai_analysis_jobs SET next_retry_at=?,last_retry_at=?,updated_at=? WHERE id=? AND status='RETRY_SCHEDULED' AND attempt_count=?",
      )
      .bind(now, now, now, result.job.id, result.job.attemptCount)
      .run();
    return {
      created: false,
      job: (await latestAiJob(db, prediction.id, 'postmatch'))!,
    };
  }
  return result;
}

export async function ensurePrematchAiJob(
  db: D1Database,
  prediction: PredictionSnapshot,
  modelId: string,
  readerContext?: PrematchReaderContext | null,
): Promise<{ created: boolean; job: ReturnType<typeof aiJobFromRow> }> {
  if (prediction.source && !prediction.source.startsWith('system'))
    throw new Error('ai_job_system_prediction_required');
  if (
    prediction.status !== 'locked' ||
    Date.parse(prediction.scheduledAt) <= Date.now()
  )
    throw new Error('prematch_window_closed');
  const prior = await latestAiJob(db, prediction.id, 'prematch');
  if (prior) return { created: false, job: prior };
  const logicalKey = logicalJobKey(
    prediction.id,
    'prematch',
    PREMATCH_JOB_PROMPT_VERSION,
    PREMATCH_JOB_SCHEMA_VERSION,
  );
  const existing = await db
    .prepare('SELECT * FROM ai_analysis_jobs WHERE logical_key=? LIMIT 1')
    .bind(logicalKey)
    .first<PredictionRow>();
  if (existing) return { created: false, job: aiJobFromRow(existing) };
  const packet = prematchInput(prediction, readerContext);
  const [rawEvidenceHash, analysisPacketHash] = await Promise.all([
    sha256(prediction.evidence),
    sha256(packet),
  ]);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO ai_analysis_jobs(
    id,logical_key,prediction_id,stage,provider,model_id,prompt_version,schema_version,status,retry_policy_version,attempt_count,
    next_retry_at,raw_evidence_hash,analysis_packet_hash,evidence_grade,analysis_packet_json,created_at,updated_at
  ) VALUES(?,? ,?,'prematch','deepseek',?,?,?,'PENDING',?,0,?,?,?,?,?,?,?) ON CONFLICT(logical_key) DO NOTHING`)
    .bind(
      id,
      logicalKey,
      prediction.id,
      modelId,
      PREMATCH_JOB_PROMPT_VERSION,
      PREMATCH_JOB_SCHEMA_VERSION,
      RETRY_POLICY_VERSION,
      now,
      rawEvidenceHash,
      analysisPacketHash,
      'C',
      JSON.stringify(packet),
      now,
      now,
    )
    .run();
  const row = await db
    .prepare('SELECT * FROM ai_analysis_jobs WHERE logical_key=? LIMIT 1')
    .bind(logicalKey)
    .first<PredictionRow>();
  if (!row) throw new Error('ai_job_insert_failed');
  return { created: asString(row.id) === id, job: aiJobFromRow(row) };
}

export async function reconcilePrematchAiJobs(
  db: D1Database,
  modelId: string,
): Promise<{ eligibleLocked: number; created: number; orphan: number }> {
  const now = new Date().toISOString();
  const rows = await db
    .prepare(`SELECT * FROM predictions p WHERE p.source LIKE 'system%' AND p.status='locked'
    AND datetime(p.scheduled_at)>datetime(?) AND NOT EXISTS(SELECT 1 FROM ai_analyses a WHERE a.prediction_id=p.id AND a.stage='prematch' AND a.status='complete')
    ORDER BY datetime(p.scheduled_at)`)
    .bind(now)
    .all<PredictionRow>();
  let created = 0;
  for (const row of rows.results ?? [])
    if ((await ensurePrematchAiJob(db, fromRow(row), modelId)).created)
      created += 1;
  const orphan = await db
    .prepare(`SELECT COUNT(*) AS count FROM predictions p WHERE p.source LIKE 'system%' AND p.status='locked'
    AND datetime(p.scheduled_at)>datetime(?) AND NOT EXISTS(SELECT 1 FROM ai_analyses a WHERE a.prediction_id=p.id AND a.stage='prematch' AND a.status='complete')
    AND NOT EXISTS(SELECT 1 FROM ai_analysis_jobs j WHERE j.prediction_id=p.id AND j.stage='prematch')`)
    .bind(now)
    .first<PredictionRow>();
  return {
    eligibleLocked: (rows.results ?? []).length,
    created,
    orphan: Number(orphan?.count ?? 0),
  };
}

export async function reconcilePostmatchAiJobs(
  db: D1Database,
  modelId: string,
): Promise<{ eligibleResolved: number; created: number; orphan: number }> {
  const rows = await db
    .prepare(`SELECT * FROM predictions WHERE source LIKE 'system%' AND status='resolved'
    AND result_evidence_json IS NOT NULL AND scorecard_json IS NOT NULL ORDER BY datetime(resolved_at)`)
    .all<PredictionRow>();
  let created = 0;
  for (const row of rows.results ?? [])
    if ((await ensurePostmatchAiJob(db, fromRow(row), modelId)).created)
      created += 1;
  const orphan = await db
    .prepare(`SELECT COUNT(*) AS count FROM predictions p WHERE p.source LIKE 'system%' AND p.status='resolved'
    AND p.result_evidence_json IS NOT NULL AND p.scorecard_json IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM ai_analysis_jobs j WHERE j.prediction_id=p.id AND j.stage='postmatch'
    ) AND NOT EXISTS(SELECT 1 FROM ai_analyses a WHERE a.prediction_id=p.id AND a.stage='postmatch' AND a.status='complete')`)
    .first<PredictionRow>();
  return {
    eligibleResolved: (rows.results ?? []).length,
    created,
    orphan: Number(orphan?.count ?? 0),
  };
}

export async function ensureDiagnosisAiJob(
  db: D1Database,
  prediction: PredictionSnapshot,
  challenger: ChallengerPrediction,
  modelId: string,
) {
  const completed = await db
    .prepare(`SELECT result_json,created_at FROM challenger_diagnoses WHERE challenger_prediction_id=? AND status='complete'
    ORDER BY datetime(created_at) DESC LIMIT 1`)
    .bind(challenger.id)
    .first<PredictionRow>();
  const revision = await db
    .prepare(
      'SELECT MAX(created_at) AS latest FROM result_evidence_revisions WHERE prediction_id=?',
    )
    .bind(prediction.id)
    .first<PredictionRow>();
  const result = {
    actualWinner: prediction.actualWinner,
    actualScore: prediction.actualScore,
  };
  if (
    completed &&
    sameJson(parseJson(completed.result_json, {}), result) &&
    (!revision?.latest ||
      Date.parse(asString(completed.created_at)) >=
        Date.parse(asString(revision.latest)))
  )
    return { created: false, status: 'SUCCESS' as const };
  const packet = buildDiagnosisPacket(prediction, challenger);
  const rawEvidenceHash = await sha256(prediction.resultEvidence);
  const analysisPacketHash = await sha256(packet);
  const logicalKey = logicalJobKey(
    prediction.id,
    'diagnosis',
    DIAGNOSIS_JOB_PROMPT_VERSION,
    `${DIAGNOSIS_JOB_SCHEMA_VERSION}:${rawEvidenceHash}`,
  );
  const existing = await db
    .prepare(
      'SELECT id,status FROM ai_analysis_jobs WHERE logical_key=? LIMIT 1',
    )
    .bind(logicalKey)
    .first<PredictionRow>();
  if (existing) return { created: false, status: asString(existing.status) };
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO ai_analysis_jobs(id,logical_key,prediction_id,stage,provider,model_id,prompt_version,schema_version,status,
    retry_policy_version,attempt_count,next_retry_at,raw_evidence_hash,analysis_packet_hash,evidence_grade,analysis_packet_json,created_at,updated_at)
    VALUES(?,?,?,'diagnosis','deepseek',?,?,?,'PENDING',?,0,?,?,?,?,?,?,?) ON CONFLICT(logical_key) DO NOTHING`)
    .bind(
      id,
      logicalKey,
      prediction.id,
      modelId,
      DIAGNOSIS_JOB_PROMPT_VERSION,
      DIAGNOSIS_JOB_SCHEMA_VERSION,
      RETRY_POLICY_VERSION,
      now,
      rawEvidenceHash,
      analysisPacketHash,
      packet.evidenceGrade,
      JSON.stringify(packet),
      now,
      now,
    )
    .run();
  const row = await db
    .prepare(
      'SELECT id,status FROM ai_analysis_jobs WHERE logical_key=? LIMIT 1',
    )
    .bind(logicalKey)
    .first<PredictionRow>();
  if (!row) throw new Error('diagnosis_job_insert_failed');
  return { created: asString(row.id) === id, status: asString(row.status) };
}

export async function reconcileDiagnosisAiJobs(
  db: D1Database,
  modelId: string,
) {
  const rows = await db
    .prepare(`SELECT p.* FROM predictions p JOIN challenger_predictions c ON c.champion_prediction_id=p.id
    WHERE p.source LIKE 'system%' AND p.status='resolved' AND c.status='resolved' AND c.eligible=1 AND c.record_kind='real_prospective'
    AND p.result_evidence_json IS NOT NULL AND p.scorecard_json IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM challenger_diagnoses d WHERE d.challenger_prediction_id=c.id AND d.status='complete'
      AND json_extract(d.result_json,'$.actualWinner')=p.actual_winner AND json_extract(d.result_json,'$.actualScore')=p.actual_score
      AND NOT EXISTS(SELECT 1 FROM result_evidence_revisions r WHERE r.prediction_id=p.id AND datetime(r.created_at)>datetime(d.created_at)))
    ORDER BY datetime(p.resolved_at) LIMIT 100`)
    .all<PredictionRow>();
  let created = 0;
  let blocked = 0;
  for (const row of rows.results ?? []) {
    try {
      const prediction = fromRow(row);
      const challenger = await challengerByChampion(db, prediction.id);
      if (
        challenger &&
        (await ensureDiagnosisAiJob(db, prediction, challenger, modelId))
          .created
      )
        created += 1;
    } catch {
      blocked += 1;
    }
  }
  return { eligibleResolved: (rows.results ?? []).length, created, blocked };
}

export async function recoverStaleAiJobs(
  db: D1Database,
  now = new Date(),
  staleMinutes = 15,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000).toISOString();
  const result = await db
    .prepare(`UPDATE ai_analysis_jobs SET status='RETRY_SCHEDULED',next_retry_at=?,last_retry_at=?,lock_token=NULL,
    error_stage='worker',error_code='stale_running_recovered',error_message='RUNNING lease expired and was recovered',updated_at=?
    WHERE status='RUNNING' AND datetime(request_started_at)<datetime(?)`)
    .bind(now.toISOString(), now.toISOString(), now.toISOString(), cutoff)
    .run();
  return Number(result.meta.changes ?? 0);
}

export async function claimDueAiJob(db: D1Database, now = new Date()) {
  const row = await db
    .prepare(`SELECT id FROM ai_analysis_jobs WHERE status IN ('PENDING','RETRY_SCHEDULED')
    AND datetime(next_retry_at)<=datetime(?) ORDER BY CASE stage WHEN 'prematch' THEN 0 WHEN 'postmatch' THEN 1 ELSE 2 END,
    datetime(next_retry_at),datetime(created_at) LIMIT 1`)
    .bind(now.toISOString())
    .first<PredictionRow>();
  if (!row) return null;
  const token = crypto.randomUUID();
  await db
    .prepare(`UPDATE ai_analysis_jobs SET status='RUNNING',attempt_count=attempt_count+1,request_started_at=?,request_completed_at=NULL,
    latency_ms=NULL,http_status=NULL,error_stage=NULL,error_code=NULL,error_message=NULL,lock_token=?,updated_at=?
    WHERE id=? AND status IN ('PENDING','RETRY_SCHEDULED')`)
    .bind(now.toISOString(), token, now.toISOString(), asString(row.id))
    .run();
  const claimed = await db
    .prepare(
      "SELECT * FROM ai_analysis_jobs WHERE id=? AND lock_token=? AND status='RUNNING' LIMIT 1",
    )
    .bind(asString(row.id), token)
    .first<PredictionRow>();
  return claimed ? aiJobFromRow(claimed) : null;
}

export async function completeAiJob(
  db: D1Database,
  job: ReturnType<typeof aiJobFromRow>,
  output: Record<string, unknown>,
  meta: {
    requestStartedAt: string;
    requestCompletedAt: string;
    latencyMs: number;
    httpStatus: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    payloadBytes: number;
  },
): Promise<void> {
  if (job.stage === 'diagnosis') {
    // The provider may finish after a source correction. Never attach its old
    // evidence to the new result; reconciliation creates a separately hashed job.
    const current = await predictionById(db, job.predictionId);
    if (
      !current ||
      current.status !== 'resolved' ||
      (await sha256(current.resultEvidence)) !== job.rawEvidenceHash
    ) {
      throw Object.assign(new Error('diagnosis_result_revision_conflict'), {
        code: 'diagnosis_result_revision_conflict',
        stage: 'evidence_gate',
        retryable: false,
      });
    }
  }
  const analysisId = crypto.randomUUID();
  const statements = [
    job.stage === 'diagnosis'
      ? modelDiagnosisStatement(db, {
          challenger: (job.analysisPacket as DiagnosisPacket).challenger,
          result: (job.analysisPacket as DiagnosisPacket).result,
          modelId: job.modelId,
          promptVersion: job.promptVersion,
          status: 'complete',
          output: output as unknown as PostmatchModelDiagnosis,
          id: analysisId,
          createdAt: meta.requestCompletedAt,
        })
      : db
          .prepare(`INSERT INTO ai_analyses(id,prediction_id,stage,provider,model_id,prompt_version,status,output_json,error_code,direct_promotion_allowed,created_at)
      VALUES(?,?,?,'deepseek',?,?,'complete',?,NULL,0,?)`)
          .bind(
            analysisId,
            job.predictionId,
            job.stage,
            job.modelId,
            job.promptVersion,
            JSON.stringify(output),
            meta.requestCompletedAt,
          ),
    db
      .prepare(`INSERT INTO ai_provider_attempts(id,job_id,attempt_no,provider,model_id,status,request_started_at,request_completed_at,
      latency_ms,http_status,input_tokens,output_tokens,payload_bytes,created_at) VALUES(?,?,?,? ,?,'SUCCESS',?,?,?,?,?,?,?,?)`)
      .bind(
        crypto.randomUUID(),
        job.id,
        job.attemptCount,
        job.provider,
        job.modelId,
        meta.requestStartedAt,
        meta.requestCompletedAt,
        meta.latencyMs,
        meta.httpStatus,
        meta.inputTokens,
        meta.outputTokens,
        meta.payloadBytes,
        meta.requestCompletedAt,
      ),
    db
      .prepare(`UPDATE ai_analysis_jobs SET status='SUCCESS',request_started_at=?,request_completed_at=?,latency_ms=?,http_status=?,
      input_tokens=?,output_tokens=?,payload_bytes=?,output_analysis_id=?,next_retry_at=NULL,lock_token=NULL,updated_at=? WHERE id=? AND status='RUNNING' AND lock_token=?`)
      .bind(
        meta.requestStartedAt,
        meta.requestCompletedAt,
        meta.latencyMs,
        meta.httpStatus,
        meta.inputTokens,
        meta.outputTokens,
        meta.payloadBytes,
        analysisId,
        meta.requestCompletedAt,
        job.id,
        job.lockToken,
      ),
  ];
  const queue =
    job.stage === 'postmatch'
      ? (output.research_queue as {
          hypothesis?: string;
          tag?: string;
          evidence_ids?: string[];
          confidence?: number;
        } | null)
      : null;
  if (queue?.hypothesis) {
    const hypothesisHash = await sha256({
      hypothesis: queue.hypothesis,
      tag: queue.tag,
    });
    statements.push(
      db
        .prepare(`INSERT INTO research_hypotheses(id,prediction_id,source_job_id,hypothesis_hash,tag,hypothesis,status,evidence_references_json,
      confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,'NEW',?,?,?,?) ON CONFLICT(source_job_id,hypothesis_hash) DO NOTHING`)
        .bind(
          crypto.randomUUID(),
          job.predictionId,
          job.id,
          hypothesisHash,
          queue.tag ?? 'unexplained',
          queue.hypothesis,
          JSON.stringify(queue.evidence_ids ?? []),
          queue.confidence ?? null,
          meta.requestCompletedAt,
          meta.requestCompletedAt,
        ),
    );
  }
  await db.batch(statements);
}

// Private append-only diagnostics reuse the existing analysis ledger. Public
// article queries accept only status='complete', never these raw responses.
export async function saveAiRequestDiagnostic(
  db: D1Database,
  job: ReturnType<typeof aiJobFromRow>,
  record: Record<string, unknown>,
) {
  await db
    .prepare(`INSERT INTO ai_analyses(id,prediction_id,stage,provider,model_id,prompt_version,status,output_json,error_code,direct_promotion_allowed,created_at)
    VALUES(?,?,?,'deepseek',?,?,'diagnostic',?,?,0,?)`)
    .bind(
      crypto.randomUUID(),
      job.predictionId,
      job.stage,
      job.modelId,
      job.promptVersion,
      JSON.stringify({
        schemaVersion: 'ai-private-attempt-v1',
        jobId: job.id,
        attempt: job.attemptCount,
        evidenceHash: job.analysisPacketHash,
        ...record,
      }),
      typeof record.error === 'string' ? record.error.slice(0, 128) : null,
      new Date().toISOString(),
    )
    .run();
}

export async function failAiJob(
  db: D1Database,
  job: ReturnType<typeof aiJobFromRow>,
  failure: ClassifiedFailure,
  timing: {
    requestStartedAt: string;
    requestCompletedAt: string;
    latencyMs: number;
    payloadBytes: number;
  },
): Promise<'RETRY_SCHEDULED' | 'FINAL_FAILED'> {
  if (job.stage === 'diagnosis') {
    const packet = job.analysisPacket as DiagnosisPacket;
    await saveModelDiagnosis(db, {
      challenger: packet.challenger,
      result: packet.result,
      modelId: job.modelId,
      promptVersion: job.promptVersion,
      status: 'failed',
      errorCode: failure.category,
    });
  }
  await db
    .prepare(`INSERT INTO ai_provider_attempts(id,job_id,attempt_no,provider,model_id,status,request_started_at,request_completed_at,
    latency_ms,http_status,error_stage,error_code,error_message,input_tokens,output_tokens,payload_bytes,created_at)
    VALUES(?,?,?,? ,?,'FAILED',?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      crypto.randomUUID(),
      job.id,
      job.attemptCount,
      job.provider,
      job.modelId,
      timing.requestStartedAt,
      timing.requestCompletedAt,
      timing.latencyMs,
      failure.httpStatus,
      failure.stage,
      failure.category,
      failure.message,
      failure.inputTokens,
      failure.outputTokens,
      failure.payloadBytes ?? timing.payloadBytes,
      timing.requestCompletedAt,
    )
    .run();
  const plan = failure.retryable
    ? retrySchedule(job.attemptCount, timing.requestCompletedAt)
    : { status: 'FINAL_FAILED' as const, nextRetryAt: null };
  if (plan.status === 'RETRY_SCHEDULED') {
    await db
      .prepare(`UPDATE ai_analysis_jobs SET status='RETRYABLE_FAILED',request_completed_at=?,latency_ms=?,http_status=?,error_stage=?,
      error_code=?,error_message=?,input_tokens=?,output_tokens=?,payload_bytes=?,lock_token=NULL,updated_at=? WHERE id=? AND status='RUNNING' AND lock_token=?`)
      .bind(
        timing.requestCompletedAt,
        timing.latencyMs,
        failure.httpStatus,
        failure.stage,
        failure.category,
        failure.message,
        failure.inputTokens,
        failure.outputTokens,
        failure.payloadBytes ?? timing.payloadBytes,
        timing.requestCompletedAt,
        job.id,
        job.lockToken,
      )
      .run();
    await db
      .prepare(
        `UPDATE ai_analysis_jobs SET status='RETRY_SCHEDULED',last_retry_at=?,next_retry_at=?,updated_at=? WHERE id=? AND status='RETRYABLE_FAILED'`,
      )
      .bind(
        timing.requestCompletedAt,
        plan.nextRetryAt,
        timing.requestCompletedAt,
        job.id,
      )
      .run();
  } else {
    await db
      .prepare(`UPDATE ai_analysis_jobs SET status='FINAL_FAILED',request_completed_at=?,latency_ms=?,http_status=?,error_stage=?,
      error_code=?,error_message=?,input_tokens=?,output_tokens=?,payload_bytes=?,next_retry_at=NULL,lock_token=NULL,updated_at=?
      WHERE id=? AND status='RUNNING' AND lock_token=?`)
      .bind(
        timing.requestCompletedAt,
        timing.latencyMs,
        failure.httpStatus,
        failure.stage,
        failure.category,
        failure.message,
        failure.inputTokens,
        failure.outputTokens,
        failure.payloadBytes ?? timing.payloadBytes,
        timing.requestCompletedAt,
        job.id,
        job.lockToken,
      )
      .run();
  }
  return plan.status;
}

export async function loadAiReliability(db: D1Database) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  async function stageHealth(stage: AiAnalysisJobPublic['stage']) {
    const [attemptRows, retryRow, orphanRow] = await Promise.all([
      db
        .prepare(`SELECT a.status,a.request_started_at,a.latency_ms,a.http_status,a.error_code,a.error_stage FROM ai_provider_attempts a
        JOIN ai_analysis_jobs j ON j.id=a.job_id WHERE j.stage=? AND datetime(a.request_started_at)>=datetime(?)
        ORDER BY datetime(a.request_started_at)`)
        .bind(stage, cutoff)
        .all<PredictionRow>(),
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM ai_analysis_jobs WHERE stage=? AND status IN ('PENDING','RUNNING','RETRYABLE_FAILED','RETRY_SCHEDULED')",
        )
        .bind(stage)
        .first<PredictionRow>(),
      stage === 'diagnosis'
        ? db
            .prepare(`SELECT COUNT(*) AS count FROM challenger_predictions c JOIN predictions p ON p.id=c.champion_prediction_id
          WHERE c.status='resolved' AND p.status='resolved' AND c.eligible=1 AND c.record_kind='real_prospective'
          AND NOT EXISTS(SELECT 1 FROM challenger_diagnoses d WHERE d.challenger_prediction_id=c.id AND d.status='complete')
          AND NOT EXISTS(SELECT 1 FROM ai_analysis_jobs j WHERE j.prediction_id=p.id AND j.stage='diagnosis')`)
            .first<PredictionRow>()
        : stage === 'postmatch'
          ? db
              .prepare(`SELECT COUNT(*) AS count FROM predictions p WHERE p.source LIKE 'system%' AND p.status='resolved' AND p.result_evidence_json IS NOT NULL
          AND p.scorecard_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_analysis_jobs j WHERE j.prediction_id=p.id AND j.stage='postmatch')
          AND NOT EXISTS(SELECT 1 FROM ai_analyses a WHERE a.prediction_id=p.id AND a.stage='postmatch' AND a.status='complete')`)
              .first<PredictionRow>()
          : db
              .prepare(`SELECT COUNT(*) AS count FROM predictions p WHERE p.source LIKE 'system%' AND p.status='locked' AND datetime(p.scheduled_at)>datetime('now')
          AND NOT EXISTS(SELECT 1 FROM ai_analyses a WHERE a.prediction_id=p.id AND a.stage='prematch' AND a.status='complete')
          AND NOT EXISTS(SELECT 1 FROM ai_analysis_jobs j WHERE j.prediction_id=p.id AND j.stage='prematch'
          AND j.prompt_version=? AND j.schema_version=?)`)
              .bind(PREMATCH_JOB_PROMPT_VERSION, PREMATCH_JOB_SCHEMA_VERSION)
              .first<PredictionRow>(),
    ]);
    const base = providerHealth(
      (attemptRows.results ?? []).map((row) => ({
        status: asString(row.status) as 'SUCCESS' | 'FAILED',
        requestStartedAt: asString(row.request_started_at),
        latencyMs: Number(row.latency_ms ?? 0),
        httpStatus: row.http_status == null ? null : Number(row.http_status),
        errorCode: row.error_code ? asString(row.error_code) : null,
        errorStage: row.error_stage ? asString(row.error_stage) : null,
      })),
    );
    return {
      ...base,
      retrying: Number(retryRow?.count ?? 0),
      orphanPredictions: Number(orphanRow?.count ?? 0),
    };
  }
  return {
    prematch: await stageHealth('prematch'),
    postmatch: await stageHealth('postmatch'),
    diagnosis: await stageHealth('diagnosis'),
    windowHours: 24 as const,
  };
}

export async function saveAutomationState(
  db: D1Database,
  input: {
    coverage: PublicOverview['data'];
    model: {
      version: string;
      role: string;
      status: string;
      parentVersion?: string | null;
      trainingCutoff?: string | null;
      minimumSampleGate: number;
      observedSamples: number;
      metrics: object;
      constraints: object;
    };
    run?: {
      id: string;
      runType: string;
      status: string;
      startedAt: string;
      completedAt?: string | null;
      counters: object;
      errorCode?: string | null;
    };
    schedule?: AutomationSchedule;
    learning?: ProspectiveLearningState;
    challenger?: object;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(`INSERT INTO data_state(key, value_json, updated_at) VALUES('coverage', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .bind(JSON.stringify(input.coverage), now),
    db
      .prepare(`INSERT INTO model_versions(version, role, status, parent_version, training_cutoff, minimum_sample_gate,
      observed_samples, metrics_json, constraints_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET role=excluded.role, status=excluded.status,
      training_cutoff=excluded.training_cutoff, minimum_sample_gate=excluded.minimum_sample_gate,
      observed_samples=excluded.observed_samples, metrics_json=excluded.metrics_json,
      constraints_json=excluded.constraints_json`)
      .bind(
        input.model.version,
        input.model.role,
        input.model.status,
        input.model.parentVersion ?? null,
        input.model.trainingCutoff ?? null,
        input.model.minimumSampleGate,
        input.model.observedSamples,
        JSON.stringify(input.model.metrics),
        JSON.stringify(input.model.constraints),
        now,
      ),
  ];
  if (input.run) {
    statements.push(
      db
        .prepare(`INSERT INTO automation_runs(
      id, run_type, status, started_at, completed_at, counters_json, error_code
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at,
      counters_json=excluded.counters_json, error_code=excluded.error_code`)
        .bind(
          input.run.id,
          input.run.runType,
          input.run.status,
          input.run.startedAt,
          input.run.completedAt ?? null,
          JSON.stringify(input.run.counters),
          input.run.errorCode ?? null,
        ),
    );
  }
  if (input.schedule) {
    statements.push(
      db
        .prepare(`INSERT INTO data_state(key, value_json, updated_at) VALUES('automation_schedule', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
        .bind(JSON.stringify(input.schedule), now),
    );
  }
  if (input.learning) {
    statements.push(
      db
        .prepare(`INSERT INTO data_state(key, value_json, updated_at) VALUES('learning_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
        .bind(JSON.stringify(input.learning), now),
    );
  }
  if (input.challenger) {
    statements.push(
      db
        .prepare(`INSERT INTO data_state(key, value_json, updated_at) VALUES('challenger_state', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
        .bind(JSON.stringify(input.challenger), now),
    );
  }
  await db.batch(statements);
}

export type PublicSyncStatus = 'RUNNING' | 'SUCCESS' | 'DEGRADED' | 'FAILED';

export async function startPublicSync(
  db: D1Database,
  input: {
    id: string;
    runnerRunId?: string | null;
    startedAt: string;
  },
): Promise<void> {
  assertIsoTimestamp(input.startedAt, 'sync_started_at');
  const existing = await db
    .prepare(
      'SELECT status,started_at,runner_run_id FROM public_sync_runs WHERE id=?',
    )
    .bind(input.id)
    .first<PredictionRow>();
  if (existing) {
    if (
      asString(existing.started_at) !== input.startedAt ||
      (existing.runner_run_id != null &&
        asString(existing.runner_run_id) !== (input.runnerRunId ?? ''))
    ) {
      throw new Error('sync_run_conflict');
    }
    return;
  }
  await db
    .prepare(`INSERT INTO public_sync_runs(
    id,runner_run_id,status,started_at,completed_at,counters_json,failures_json,error_code
  ) VALUES(?,?, 'RUNNING', ?,NULL,'{}','[]',NULL)`)
    .bind(input.id, input.runnerRunId ?? null, input.startedAt)
    .run();
}

export async function finishPublicSync(
  db: D1Database,
  input: {
    id: string;
    status: Exclude<PublicSyncStatus, 'RUNNING'>;
    completedAt: string;
    counters: Record<string, unknown>;
    failures: Array<{ type: string; id: string; error: string }>;
    errorCode?: string | null;
  },
): Promise<void> {
  if (!['SUCCESS', 'DEGRADED', 'FAILED'].includes(input.status))
    throw new Error('invalid_sync_status');
  assertIsoTimestamp(input.completedAt, 'sync_completed_at');
  const existing = await db
    .prepare('SELECT status,started_at FROM public_sync_runs WHERE id=?')
    .bind(input.id)
    .first<PredictionRow>();
  if (!existing) throw new Error('sync_run_not_found');
  if (asString(existing.status) !== 'RUNNING') {
    const current = await db
      .prepare(
        'SELECT status,completed_at,counters_json,failures_json,error_code FROM public_sync_runs WHERE id=?',
      )
      .bind(input.id)
      .first<PredictionRow>();
    const same =
      asString(current?.status) === input.status &&
      asString(current?.completed_at) === input.completedAt &&
      sameJson(parseJson(current?.counters_json, {}), input.counters) &&
      sameJson(parseJson(current?.failures_json, []), input.failures) &&
      (current?.error_code == null ? null : asString(current.error_code)) ===
        (input.errorCode ?? null);
    if (!same) throw new Error('sync_run_final_conflict');
    return;
  }
  await db
    .prepare(`UPDATE public_sync_runs SET status=?,completed_at=?,counters_json=?,failures_json=?,error_code=?
    WHERE id=? AND status='RUNNING'`)
    .bind(
      input.status,
      input.completedAt,
      JSON.stringify(input.counters),
      JSON.stringify(input.failures),
      input.errorCode ?? null,
      input.id,
    )
    .run();
}

export async function loadAutomationHealth(): Promise<AutomationHealth> {
  const [
    runRow,
    syncRow,
    successfulSyncRow,
    scheduleRow,
    coverageRow,
    aiRow,
    queueRow,
  ] = await Promise.all([
    env.DB.prepare(`SELECT status, started_at, completed_at, counters_json, error_code
      FROM automation_runs ORDER BY datetime(started_at) DESC LIMIT 1`).first<PredictionRow>(),
    env.DB.prepare(`SELECT id,status,started_at,completed_at,counters_json,failures_json,error_code
      FROM public_sync_runs ORDER BY datetime(started_at) DESC,id DESC LIMIT 1`).first<PredictionRow>(),
    env.DB.prepare(`SELECT completed_at FROM public_sync_runs WHERE status='SUCCESS'
      ORDER BY datetime(completed_at) DESC LIMIT 1`).first<PredictionRow>(),
    env.DB.prepare(
      `SELECT value_json FROM data_state WHERE key='automation_schedule' LIMIT 1`,
    ).first<PredictionRow>(),
    env.DB.prepare(
      `SELECT updated_at FROM data_state WHERE key='coverage' LIMIT 1`,
    ).first<PredictionRow>(),
    env.DB.prepare(
      `SELECT MAX(created_at) AS completed_at FROM ai_analyses WHERE status='complete'`,
    ).first<PredictionRow>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN source LIKE 'system%' AND status='locked' THEN 1 ELSE 0 END) AS pending_results,
      SUM(CASE WHEN source LIKE 'system%' AND status='resolved' AND NOT EXISTS (
        SELECT 1 FROM ai_analyses a WHERE a.prediction_id=predictions.id AND a.stage='postmatch' AND a.status='complete'
      ) THEN 1 ELSE 0 END) AS pending_reviews
      FROM predictions`).first<PredictionRow>(),
  ]);
  const schedule = scheduleRow?.value_json
    ? parseJson<AutomationSchedule>(scheduleRow.value_json, {
        intervalSeconds: 7200,
        horizonHours: 48,
        executionEnvironment: 'cloud',
      })
    : {
        intervalSeconds: 7200,
        horizonHours: 48,
        executionEnvironment: 'cloud' as const,
      };
  const lastRunStartedAt = syncRow?.started_at
    ? asString(syncRow.started_at)
    : runRow?.started_at
      ? asString(runRow.started_at)
      : null;
  const lastRunCompletedAt = syncRow?.completed_at
    ? asString(syncRow.completed_at)
    : runRow?.completed_at
      ? asString(runRow.completed_at)
      : null;
  const intervalSeconds = Number(schedule.intervalSeconds || 7200);
  const lastCompletedMs = lastRunCompletedAt
    ? Date.parse(lastRunCompletedAt)
    : Number.NaN;
  const nextExpectedAt = Number.isFinite(lastCompletedMs)
    ? new Date(lastCompletedMs + intervalSeconds * 1000).toISOString()
    : null;
  const staleAfterMs = intervalSeconds * 2.5 * 1000;
  let status: AutomationHealth['status'] = 'waiting';
  if (syncRow) {
    const syncStatus = asString(syncRow.status);
    status =
      syncStatus === 'FAILED'
        ? 'failed'
        : syncStatus === 'DEGRADED'
          ? 'degraded'
          : syncStatus === 'RUNNING'
            ? 'waiting'
            : !Number.isFinite(lastCompletedMs) ||
                Date.now() - lastCompletedMs > staleAfterMs
              ? 'stale'
              : 'healthy';
  } else if (runRow) {
    const failed =
      Boolean(runRow.error_code) ||
      ['failed', 'partial_failure'].includes(asString(runRow.status));
    status = failed
      ? 'degraded'
      : !Number.isFinite(lastCompletedMs) ||
          Date.now() - lastCompletedMs > staleAfterMs
        ? 'stale'
        : 'healthy';
  }
  return {
    status,
    lastRunStatus: runRow?.status ? asString(runRow.status) : null,
    lastRunStartedAt,
    lastRunCompletedAt,
    nextExpectedAt,
    dataUpdatedAt: coverageRow?.updated_at
      ? asString(coverageRow.updated_at)
      : null,
    lastAiCompletedAt: aiRow?.completed_at
      ? asString(aiRow.completed_at)
      : null,
    intervalSeconds,
    horizonHours: Number(schedule.horizonHours || 48),
    pendingResults: Number(queueRow?.pending_results ?? 0),
    pendingReviews: Number(queueRow?.pending_reviews ?? 0),
    lastCounters: parseJson<Record<string, unknown>>(
      syncRow?.counters_json ?? runRow?.counters_json,
      {},
    ),
    syncRunId: syncRow?.id ? asString(syncRow.id) : null,
    syncStatus: syncRow?.status
      ? (asString(syncRow.status) as AutomationHealth['syncStatus'])
      : null,
    lastSuccessfulSyncAt: successfulSyncRow?.completed_at
      ? asString(successfulSyncRow.completed_at)
      : null,
    syncFailures: parseJson<Array<{ type: string; id: string; error: string }>>(
      syncRow?.failures_json,
      [],
    ),
  };
}

export async function loadEvaluationIntegrity(
  db: D1Database,
  supplied?: PublicOverview['challenger'],
) {
  let challenger = supplied;
  if (challenger === undefined) {
    const row = await db
      .prepare(
        "SELECT value_json FROM data_state WHERE key='challenger_state' LIMIT 1",
      )
      .first<PredictionRow>();
    challenger = row
      ? parseJson<PublicOverview['challenger']>(row.value_json, null)
      : null;
  }
  const rows = await db
    .prepare(`SELECT c.*,p.actual_winner AS canonical_winner,p.team_a,p.team_b,p.status AS canonical_status,
    p.source AS canonical_source,p.team_a_probability AS canonical_probability,p.locked_at AS canonical_locked_at,p.scheduled_at AS canonical_scheduled_at
    FROM challenger_predictions c JOIN predictions p ON p.id=c.champion_prediction_id
    WHERE c.status='resolved' AND c.eligible=1 AND c.record_kind='real_prospective'`)
    .all<PredictionRow>();
  return checkEvaluationIntegrity(rows.results ?? [], challenger ?? null);
}

export async function loadPublicOverview(): Promise<PublicOverview> {
  const modelId = env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  try {
    const livePrediction = await latestPrediction(env.DB);
    const prediction = livePrediction ?? fallbackOverview.prediction;
    const automation = await loadAutomationHealth();
    const aiReliability = await loadAiReliability(env.DB);
    const analysisRow =
      await env.DB.prepare(`SELECT output_json, status FROM ai_analyses
      WHERE prediction_id = ? AND stage = 'prematch' ORDER BY datetime(created_at) DESC LIMIT 1`)
        .bind(prediction.id)
        .first<Record<string, unknown>>();
    const counts = await env.DB.prepare(`SELECT COUNT(*) AS predictions,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved FROM predictions
      WHERE source LIKE 'system%'`).first<Record<string, number>>();
    const modelRow =
      await env.DB.prepare(`SELECT version, observed_samples, minimum_sample_gate, status FROM model_versions
      WHERE role='champion' ORDER BY datetime(created_at) DESC LIMIT 1`).first<
        Record<string, unknown>
      >();
    const coverageRow = await env.DB.prepare(
      `SELECT value_json FROM data_state WHERE key='coverage' LIMIT 1`,
    ).first<Record<string, unknown>>();
    const learningRow = await env.DB.prepare(
      `SELECT value_json FROM data_state WHERE key='learning_state' LIMIT 1`,
    ).first<Record<string, unknown>>();
    const challengerRow = await env.DB.prepare(
      `SELECT value_json FROM data_state WHERE key='challenger_state' LIMIT 1`,
    ).first<Record<string, unknown>>();
    const challenger = challengerRow?.value_json
      ? parseJson<PublicOverview['challenger']>(challengerRow.value_json, null)
      : null;
    const evaluationIntegrity = await loadEvaluationIntegrity(
      env.DB,
      challenger,
    );
    const coverage = coverageRow?.value_json
      ? parseJson<Partial<PublicOverview['data']>>(coverageRow.value_json, {})
      : {};
    return {
      dataMode: livePrediction
        ? automation.status === 'healthy'
          ? 'LIVE'
          : 'DEGRADED'
        : 'DEMO',
      dataModeReason: livePrediction
        ? automation.status === 'healthy'
          ? null
          : '生产数据库可读，但最近公开同步并非完整成功；当前展示最后已保存的生产记录。'
        : '生产数据库当前没有正式系统预测，页面显示明确标记的演示样本。',
      prediction,
      data: {
        ...fallbackOverview.data,
        ...coverage,
        predictions: Number(
          counts?.predictions ??
            coverage.predictions ??
            fallbackOverview.data.predictions,
        ),
      },
      ai: {
        configured: Boolean(env.DEEPSEEK_API_KEY),
        status:
          analysisRow?.status === 'complete'
            ? 'available'
            : env.DEEPSEEK_API_KEY
              ? 'ready'
              : 'waiting_for_key',
        modelId,
        analysis: analysisRow?.output_json
          ? parseJson<PrematchAiAnalysis | null>(analysisRow.output_json, null)
          : null,
      },
      governance: {
        champion: asString(
          modelRow?.version,
          fallbackOverview.governance.champion,
        ),
        globalWeightsFrozen: true,
        observedSamples: Number(
          modelRow?.observed_samples ??
            counts?.resolved ??
            fallbackOverview.governance.observedSamples,
        ),
        minimumSampleGate: Number(
          modelRow?.minimum_sample_gate ??
            fallbackOverview.governance.minimumSampleGate,
        ),
        promotionEnabled: false,
      },
      automation,
      learning: learningRow?.value_json
        ? parseJson<ProspectiveLearningState>(
            learningRow.value_json,
            fallbackOverview.learning,
          )
        : fallbackOverview.learning,
      challenger,
      evaluationIntegrity,
      aiReliability,
    };
  } catch (error) {
    return {
      ...fallbackOverview,
      dataMode: 'DEGRADED',
      dataModeReason: `实时数据读取失败；当前仅显示明确标记的演示样本（${error instanceof Error ? error.message : 'unknown_error'}）。`,
      ai: {
        ...fallbackOverview.ai,
        configured: Boolean(env.DEEPSEEK_API_KEY),
        modelId,
      },
    };
  }
}
