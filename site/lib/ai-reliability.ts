import type {
  FactorContribution,
  PredictionSnapshot,
  ResultEvidenceEnvelope,
} from './vct-types';
import { readerInsights, validateReaderReview } from './reader-analysis.ts';
import type { ReaderInsights } from './reader-analysis.ts';
import { CN_MAPS } from './valorant-terms.ts';
import {
  EVIDENCE_REVIEW_PROMPT,
  EVIDENCE_REVIEW_SCHEMA,
  validateEvidenceArticle,
} from './review-evidence.ts';

export const POSTMATCH_JOB_PROMPT_VERSION = EVIDENCE_REVIEW_PROMPT;
export const POSTMATCH_JOB_SCHEMA_VERSION = EVIDENCE_REVIEW_SCHEMA;
export const PREMATCH_JOB_PROMPT_VERSION = 'vct-prematch-deepseek-v4-evidence1';
export const PREMATCH_JOB_SCHEMA_VERSION = 'v1.4c-r2.2-prematch-analysis-v1';
export const RETRY_POLICY_VERSION = 'v1.4c-r2-retry-v1';
// DeepSeek counts hidden reasoning and visible JSON against the same output
// budget. R2 is evidence extraction, so preserve the budget for structured JSON.
export const POSTMATCH_R2_REASONING_EFFORT = 'none' as const;
export const RETRY_DELAYS_SECONDS = [0, 300, 1_800, 7_200, 43_200] as const;

export type AiJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'RETRYABLE_FAILED'
  | 'RETRY_SCHEDULED'
  | 'SUCCESS'
  | 'FINAL_FAILED';
export type AiFailureCategory =
  | 'PROVIDER_429'
  | 'PROVIDER_5XX'
  | 'TIMEOUT_CONNECTION'
  | 'PAYLOAD_CONTEXT'
  | 'INVALID_JSON'
  | 'SCHEMA_VALIDATION'
  | 'DB_WRITE_DUPLICATE'
  | 'PROMPT'
  | 'UNKNOWN';

export type ProviderAttemptRecord = {
  status: 'SUCCESS' | 'FAILED';
  requestStartedAt: string;
  latencyMs: number;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorStage?: string | null;
};

export type ClassifiedFailure = {
  category: AiFailureCategory;
  retryable: boolean;
  stage: string;
  code: string;
  message: string;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  payloadBytes: number | null;
};

export type EvidenceValue<T> = {
  value: T | null;
  status: 'observed' | 'missing' | 'unavailable_not_frozen';
};

export type AnalysisPacket = {
  schemaVersion: 'v1.4c-r2-analysis-packet-v1';
  // Additive task context; older persisted packets remain valid and unchanged.
  reviewFocus?: 'team_outcomes_v1';
  readerInsights?: ReaderInsights;
  teamOutcomes?: Array<{
    team: string;
    outcome: 'won' | 'lost';
    wonMapOrders: number[];
    lostMapOrders: number[];
  }>;
  prediction: {
    predictionId: string;
    event: string;
    region: string;
    seriesFormat: string;
    scheduledAt: string;
    lockedAt: string;
    teamA: string;
    teamB: string;
    championProbabilityTeamA: number;
    predictedScore: string;
    actualWinner: string | null;
    actualScore: string | null;
    actualPlayedAt: EvidenceValue<string>;
    sourceMatchTime: string | null;
    resultCapturedAt: string | null;
  };
  deterministicScorecard: PredictionSnapshot['scorecard'];
  factorConflictMatrix: Array<
    FactorContribution & {
      direction: 'team_a' | 'team_b' | 'neutral';
      resultRelation: 'supported' | 'contradicted' | 'neutral';
    }
  >;
  maps: Array<{
    order: number;
    map: string;
    score: string;
    winner: string;
    predictedProbabilityTeamA: number | null;
    probabilityStatus: 'observed' | 'unavailable';
    predictionCorrect: boolean | null;
    winnerSurprisal: number | null;
    samples: [number, number] | null;
    teamAMapRating: number | null;
    teamBMapRating: number | null;
    missingFields: string[];
  }>;
  playerOutliers: Array<{
    mapOrder: number;
    map: string;
    playerId: string | null;
    player: string;
    teamId: string | null;
    agent: EvidenceValue<string>;
    metrics: Record<string, EvidenceValue<number>>;
    outlierBasis: 'rating' | 'acs' | 'unavailable';
    deltaFromMapMean: number | null;
    baselineStatus: 'unavailable_not_frozen';
  }>;
  compositions: Array<{
    mapOrder: number;
    teamId: string;
    agents: string[];
    roleCounts: Record<string, number>;
    archetype: string;
    unknownAgents: string[];
  }>;
  roster: {
    actualObserved: Record<string, string[]>;
    expectedPrematch: Record<string, never>;
    mismatchStatus: 'unavailable_not_frozen';
  };
  coverage: {
    series: boolean;
    mapsPlayed: number;
    mapProbabilityMatched: number;
    mapProbabilityCoverage: number;
    playerRows: number;
    playerMapRowsExpected: number;
    playerMetricCoverage: Record<string, number>;
    veto: boolean;
    attackDefense: boolean;
    rosterActual: boolean;
    rosterExpectedFrozen: boolean;
  };
  evidenceGrade: 'A' | 'B' | 'C' | 'D';
  missingEvidence: string[];
  evidenceReferences: string[];
  governance: {
    aiMayRecomputeFormalMetrics: false;
    aiMayChangeProbability: false;
    aiMayTrainModel: false;
    aiMayPromoteModel: false;
    causalStatementsMustBeHypotheses: true;
  };
};

const mapAliases = CN_MAPS;

const agentRoles: Record<string, string> = {
  jett: 'duelist',
  raze: 'duelist',
  neon: 'duelist',
  phoenix: 'duelist',
  reyna: 'duelist',
  yoru: 'duelist',
  iso: 'duelist',
  waylay: 'duelist',
  omen: 'controller',
  viper: 'controller',
  brimstone: 'controller',
  astra: 'controller',
  harbor: 'controller',
  clove: 'controller',
  sova: 'initiator',
  fade: 'initiator',
  gekko: 'initiator',
  breach: 'initiator',
  kayo: 'initiator',
  skye: 'initiator',
  tejo: 'initiator',
  cypher: 'sentinel',
  killjoy: 'sentinel',
  chamber: 'sentinel',
  sage: 'sentinel',
  deadlock: 'sentinel',
  vyse: 'sentinel',
  veto: 'sentinel',
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function sameFrozenMapSnapshot(
  frozen: PredictionSnapshot['maps'],
  incoming: PredictionSnapshot['maps'],
): boolean {
  if (frozen.length !== incoming.length) return false;
  const comparableIncoming = incoming.map((map, index) => {
    const baseline = frozen[index] as Record<string, unknown>;
    const comparable = { ...map } as Record<string, unknown>;
    // Older frozen rows predate these optional explanatory values. Accept the
    // additive fields without writing them back; all original frozen fields
    // still have to match exactly.
    for (const key of ['teamAMapRating', 'teamBMapRating']) {
      if (!Object.prototype.hasOwnProperty.call(baseline, key))
        delete comparable[key];
    }
    return comparable;
  });
  return canonicalJson(frozen) === canonicalJson(comparableIncoming);
}

export function sameFrozenResultEvidence(
  frozen: ResultEvidenceEnvelope,
  incoming: ResultEvidenceEnvelope,
): boolean {
  const comparableIncoming: ResultEvidenceEnvelope = {
    ...incoming,
    source: { ...incoming.source, capturedAt: frozen.source.capturedAt },
  };
  // capturedAt is the first accepted observation time. A later delivery may
  // carry a different transport observation time, but every competition fact
  // remains strictly immutable and is still compared canonically.
  return canonicalJson(frozen) === canonicalJson(comparableIncoming);
}

export function matchesArchivedResultDelivery(
  archived: {
    winner: string | null;
    score: string | null;
    evidence: ResultEvidenceEnvelope | null;
  },
  incoming: { winner: string; score: string; evidence: ResultEvidenceEnvelope },
): boolean {
  return (
    archived.winner === incoming.winner &&
    archived.score === incoming.score &&
    Boolean(
      archived.evidence &&
      sameFrozenResultEvidence(archived.evidence, incoming.evidence),
    )
  );
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(
    typeof value === 'string' ? value : canonicalJson(value),
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeMapName(value: string): string {
  return mapAliases[value.trim().toLowerCase()] ?? value;
}

function metric(value: unknown): EvidenceValue<number> {
  return typeof value === 'number' && Number.isFinite(value)
    ? { value, status: 'observed' }
    : { value: null, status: 'missing' };
}

function agentMetric(value: unknown): EvidenceValue<string> {
  return typeof value === 'string' && value.trim()
    ? { value: value.trim(), status: 'observed' }
    : { value: null, status: 'missing' };
}

function actualWinnerRelation(
  factor: FactorContribution,
  prediction: PredictionSnapshot,
): 'supported' | 'contradicted' | 'neutral' {
  if (!prediction.actualWinner || factor.probabilityPoints === 0)
    return 'neutral';
  const supportsA = factor.probabilityPoints > 0;
  return (supportsA && prediction.actualWinner === prediction.teamA) ||
    (!supportsA && prediction.actualWinner === prediction.teamB)
    ? 'supported'
    : 'contradicted';
}

function compositionArchetype(
  roleCounts: Record<string, number>,
  unknownAgents: string[],
): string {
  if (unknownAgents.length) return 'partial_unknown';
  if ((roleCounts.duelist ?? 0) >= 2) return 'double_duelist';
  if ((roleCounts.controller ?? 0) >= 2) return 'double_controller';
  if ((roleCounts.initiator ?? 0) >= 2) return 'double_initiator';
  if ((roleCounts.sentinel ?? 0) >= 2) return 'double_sentinel';
  return 'balanced_single_roles';
}

export function evidenceGrade(input: {
  series: boolean;
  maps: boolean;
  players: boolean;
  veto: boolean;
  roster: boolean;
}): 'A' | 'B' | 'C' | 'D' {
  if (input.series && input.maps && input.players && input.veto && input.roster)
    return 'A';
  if (input.series && input.maps && input.players && input.roster) return 'B';
  if (input.series && input.maps) return 'C';
  return 'D';
}

export function buildAnalysisPacket(
  prediction: PredictionSnapshot,
): AnalysisPacket {
  const result = prediction.resultEvidence;
  const actualMaps = result?.maps ?? [];
  const rawPlayers = (result?.playerStats ?? []) as Array<
    Record<string, unknown>
  >;
  const mapNames = new Map(
    actualMaps.map((item) => [item.order, normalizeMapName(item.map)]),
  );
  const candidateMaps = new Map(
    prediction.maps.map((item) => [normalizeMapName(item.map), item]),
  );
  const maps = actualMaps.map((item) => {
    const name = normalizeMapName(item.map);
    const candidate = candidateMaps.get(name);
    const winnerProbability = candidate
      ? item.winner === prediction.teamA
        ? candidate.teamAProbability
        : candidate.teamBProbability
      : null;
    return {
      order: item.order,
      map: name,
      score: `${item.teamAScore}-${item.teamBScore}`,
      winner: item.winner,
      predictedProbabilityTeamA: candidate?.teamAProbability ?? null,
      probabilityStatus: candidate
        ? ('observed' as const)
        : ('unavailable' as const),
      predictionCorrect: candidate
        ? candidate.teamAProbability >= 0.5 ===
          (item.winner === prediction.teamA)
        : null,
      winnerSurprisal: winnerProbability
        ? -Math.log(Math.max(winnerProbability, 1e-15))
        : null,
      samples: candidate?.samples ?? null,
      teamAMapRating: candidate?.teamAMapRating ?? null,
      teamBMapRating: candidate?.teamBMapRating ?? null,
      missingFields: item.missingFields,
    };
  });

  const numericFields = [
    'rating',
    'acs',
    'kills',
    'deaths',
    'assists',
    'kast',
    'adr',
    'hsPct',
    'firstKills',
    'firstDeaths',
  ] as const;
  const grouped = new Map<number, Array<Record<string, unknown>>>();
  for (const row of rawPlayers) {
    const order = Number(row.mapOrder);
    if (!Number.isInteger(order)) continue;
    grouped.set(order, [...(grouped.get(order) ?? []), row]);
  }
  const rankedPlayers = rawPlayers
    .map((row) => {
      const order = Number(row.mapOrder);
      const peers = grouped.get(order) ?? [];
      const basis =
        typeof row.rating === 'number'
          ? 'rating'
          : typeof row.acs === 'number'
            ? 'acs'
            : 'unavailable';
      const values =
        basis === 'unavailable'
          ? []
          : peers
              .map((item) => item[basis])
              .filter(
                (value): value is number =>
                  typeof value === 'number' && Number.isFinite(value),
              );
      const value = basis === 'unavailable' ? null : (row[basis] as number);
      const mean = values.length
        ? values.reduce((sum, item) => sum + item, 0) / values.length
        : null;
      const delta = value == null || mean == null ? null : value - mean;
      return {
        row,
        order,
        basis,
        delta,
        magnitude: delta == null ? -1 : Math.abs(delta),
      };
    })
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 4);
  const playerOutliers = rankedPlayers.map(({ row, order, basis, delta }) => ({
    mapOrder: order,
    map: mapNames.get(order) ?? `第${order}图`,
    playerId: typeof row.playerId === 'string' ? row.playerId : null,
    player: typeof row.player === 'string' ? row.player : '未知选手',
    teamId: typeof row.teamId === 'string' ? row.teamId : null,
    agent: agentMetric(row.agent),
    metrics: Object.fromEntries(
      numericFields.map((field) => [field, metric(row[field])]),
    ),
    outlierBasis: basis as 'rating' | 'acs' | 'unavailable',
    deltaFromMapMean: delta,
    baselineStatus: 'unavailable_not_frozen' as const,
  }));

  const compositionGroups = new Map<
    string,
    { mapOrder: number; teamId: string; agents: string[] }
  >();
  const actualRoster: Record<string, Set<string>> = {};
  for (const row of rawPlayers) {
    const mapOrder = Number(row.mapOrder);
    const teamId = typeof row.teamId === 'string' ? row.teamId : 'unknown_team';
    const key = `${mapOrder}:${teamId}`;
    const current = compositionGroups.get(key) ?? {
      mapOrder,
      teamId,
      agents: [],
    };
    if (typeof row.agent === 'string')
      current.agents.push(
        ...row.agent
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      );
    compositionGroups.set(key, current);
    if (!actualRoster[teamId]) actualRoster[teamId] = new Set();
    if (typeof row.playerId === 'string')
      actualRoster[teamId].add(row.playerId);
  }
  const compositions = [...compositionGroups.values()].map((item) => {
    const roleCounts: Record<string, number> = {};
    const unknownAgents: string[] = [];
    for (const agent of item.agents) {
      const role = agentRoles[agent];
      if (role) roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      else unknownAgents.push(agent);
    }
    return {
      ...item,
      roleCounts,
      archetype: compositionArchetype(roleCounts, unknownAgents),
      unknownAgents,
    };
  });
  const playerMetricCoverage = Object.fromEntries(
    numericFields.map((field) => {
      const observed = rawPlayers.filter(
        (row) => typeof row[field] === 'number' && Number.isFinite(row[field]),
      ).length;
      return [field, rawPlayers.length ? observed / rawPlayers.length : 0];
    }),
  );
  const mapProbabilityMatched = maps.filter(
    (item) => item.probabilityStatus === 'observed',
  ).length;
  const rosterActual = Object.values(actualRoster).some(
    (players) => players.size > 0,
  );
  const grade = evidenceGrade({
    series: Boolean(result?.series),
    maps: maps.length > 0,
    players: rawPlayers.length > 0,
    veto: result?.missing.veto === false,
    roster: rosterActual,
  });
  const missingEvidence = [
    ...(result?.missing.maps ? ['map_results'] : []),
    ...(result?.missing.playerStats ? ['player_map_stats'] : []),
    ...(result?.missing.attackDefense ? ['attack_defense'] : []),
    ...(result?.missing.veto ? ['veto_bp'] : []),
    'actual_played_at',
    'prematch_player_map_baseline',
    'prematch_expected_roster',
    'economy',
    'pistol_rounds',
    'clutch',
    'round_timeline',
  ];
  return {
    schemaVersion: 'v1.4c-r2-analysis-packet-v1',
    reviewFocus: 'team_outcomes_v1',
    teamOutcomes: [prediction.teamA, prediction.teamB].map((team) => ({
      team,
      outcome: team === prediction.actualWinner ? 'won' : 'lost',
      wonMapOrders: maps
        .filter((map) => map.winner === team)
        .map((map) => map.order),
      lostMapOrders: maps
        .filter((map) => map.winner !== team)
        .map((map) => map.order),
    })),
    prediction: {
      predictionId: prediction.id,
      event: prediction.event,
      region: prediction.region,
      seriesFormat: prediction.seriesFormat,
      scheduledAt: prediction.scheduledAt,
      lockedAt: prediction.lockedAt,
      teamA: prediction.teamA,
      teamB: prediction.teamB,
      championProbabilityTeamA: prediction.teamAProbability,
      predictedScore: prediction.predictedScore,
      actualWinner: prediction.actualWinner ?? null,
      actualScore: prediction.actualScore ?? null,
      actualPlayedAt: { value: null, status: 'unavailable_not_frozen' },
      sourceMatchTime: result?.series.playedAt ?? null,
      resultCapturedAt:
        result?.source.capturedAt ?? prediction.resolvedAt ?? null,
    },
    deterministicScorecard: prediction.scorecard ?? null,
    factorConflictMatrix: [...prediction.factors]
      .sort((a, b) => a.rank - b.rank)
      .map((factor) => ({
        ...factor,
        direction:
          factor.probabilityPoints > 0
            ? 'team_a'
            : factor.probabilityPoints < 0
              ? 'team_b'
              : 'neutral',
        resultRelation: actualWinnerRelation(factor, prediction),
      })),
    maps,
    readerInsights: readerInsights(prediction),
    playerOutliers,
    compositions,
    roster: {
      actualObserved: Object.fromEntries(
        Object.entries(actualRoster).map(([team, players]) => [
          team,
          [...players].sort(),
        ]),
      ),
      expectedPrematch: {},
      mismatchStatus: 'unavailable_not_frozen',
    },
    coverage: {
      series: Boolean(result?.series),
      mapsPlayed: maps.length,
      mapProbabilityMatched,
      mapProbabilityCoverage: maps.length
        ? mapProbabilityMatched / maps.length
        : 0,
      playerRows: rawPlayers.length,
      playerMapRowsExpected: maps.length * 10,
      playerMetricCoverage,
      veto: result?.missing.veto === false,
      attackDefense: result?.missing.attackDefense === false,
      rosterActual,
      rosterExpectedFrozen: false,
    },
    evidenceGrade: grade,
    missingEvidence: [...new Set(missingEvidence)],
    evidenceReferences: [
      'prediction:locked_snapshot',
      'system:scorecard',
      'fact:result_evidence',
      ...maps.map((item) => `fact:map:${item.order}`),
      ...readerInsights(prediction).maps.flatMap((map) =>
        map.players.map(
          (player) => `fact:reader-player:${map.order}:${player.id}`,
        ),
      ),
      ...playerOutliers.map(
        (item) =>
          `fact:player:${item.mapOrder}:${item.playerId ?? item.player}`,
      ),
    ],
    governance: {
      aiMayRecomputeFormalMetrics: false,
      aiMayChangeProbability: false,
      aiMayTrainModel: false,
      aiMayPromoteModel: false,
      causalStatementsMustBeHypotheses: true,
    },
  };
}

export async function packetWithHashes(
  prediction: PredictionSnapshot,
): Promise<{
  packet: AnalysisPacket;
  rawEvidenceHash: string;
  analysisPacketHash: string;
}> {
  const packet = buildAnalysisPacket(prediction);
  const rawEvidence = {
    predictionLock: {
      ...prediction,
      resultEvidence: undefined,
      scorecard: undefined,
    },
    resultEvidence: prediction.resultEvidence,
    scorecard: prediction.scorecard,
  };
  return {
    packet,
    rawEvidenceHash: await sha256(rawEvidence),
    analysisPacketHash: await sha256(packet),
  };
}

export function logicalJobKey(
  predictionId: string,
  stage: string,
  promptVersion: string,
  schemaVersion: string,
): string {
  return [predictionId, stage, promptVersion, schemaVersion].join('|');
}

const transitions: Record<AiJobStatus, AiJobStatus[]> = {
  PENDING: ['RUNNING'],
  RUNNING: ['SUCCESS', 'RETRYABLE_FAILED', 'FINAL_FAILED'],
  RETRYABLE_FAILED: ['RETRY_SCHEDULED'],
  RETRY_SCHEDULED: ['RUNNING'],
  SUCCESS: [],
  FINAL_FAILED: [],
};

export function assertJobTransition(from: AiJobStatus, to: AiJobStatus): void {
  if (!transitions[from].includes(to))
    throw new Error(`invalid_ai_job_transition_${from}_to_${to}`);
}

export function retrySchedule(
  attemptCount: number,
  completedAt: string,
): { status: 'RETRY_SCHEDULED' | 'FINAL_FAILED'; nextRetryAt: string | null } {
  if (attemptCount >= RETRY_DELAYS_SECONDS.length)
    return { status: 'FINAL_FAILED', nextRetryAt: null };
  return {
    status: 'RETRY_SCHEDULED',
    nextRetryAt: new Date(
      Date.parse(completedAt) + RETRY_DELAYS_SECONDS[attemptCount] * 1000,
    ).toISOString(),
  };
}

export function classifyAiFailure(error: unknown): ClassifiedFailure {
  const item = error as {
    message?: string;
    code?: string;
    stage?: string;
    httpStatus?: number | null;
    retryable?: boolean;
    inputTokens?: number | null;
    outputTokens?: number | null;
    payloadBytes?: number | null;
  };
  const message = String(item?.message || 'unknown_ai_error').slice(0, 512);
  const code = String(item?.code || message).slice(0, 128);
  const httpStatus =
    typeof item?.httpStatus === 'number' ? item.httpStatus : null;
  let category: AiFailureCategory = 'UNKNOWN';
  let retryable = Boolean(item?.retryable);
  let stage = item?.stage || 'unknown';
  if (httpStatus === 429 || /http_429|rate.?limit/i.test(code + message)) {
    category = 'PROVIDER_429';
    retryable = true;
    stage = 'provider';
  } else if (
    (httpStatus != null && httpStatus >= 500) ||
    /http_5\d\d/i.test(code + message)
  ) {
    category = 'PROVIDER_5XX';
    retryable = true;
    stage = 'provider';
  } else if (
    /timeout|abort|connection|network|fetch failed/i.test(code + message)
  ) {
    category = 'TIMEOUT_CONNECTION';
    retryable = true;
    stage = 'transport';
  } else if (/max_output|context|payload|too_large|413/i.test(code + message)) {
    category = 'PAYLOAD_CONTEXT';
    retryable = false;
    stage = 'payload';
  } else if (
    /json|unterminated|double-quoted|property name/i.test(code + message)
  ) {
    category = 'INVALID_JSON';
    retryable = true;
    stage = 'parse';
  } else if (/schema|required|enum|validation/i.test(code + message)) {
    category = 'SCHEMA_VALIDATION';
    retryable = false;
    stage = 'schema';
  } else if (
    /database|d1|constraint|unique|duplicate|write/i.test(code + message)
  ) {
    category = 'DB_WRITE_DUPLICATE';
    retryable = false;
    stage = 'database';
  } else if (/prompt|instruction/i.test(code + message)) {
    category = 'PROMPT';
    retryable = false;
    stage = 'prompt';
  }
  return {
    category,
    retryable,
    stage,
    code,
    message,
    httpStatus,
    inputTokens: item?.inputTokens ?? null,
    outputTokens: item?.outputTokens ?? null,
    payloadBytes: item?.payloadBytes ?? null,
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

export function providerHealth(attempts: ProviderAttemptRecord[]) {
  const attempted = attempts.length;
  const succeeded = attempts.filter((item) => item.status === 'SUCCESS').length;
  const failed = attempted - succeeded;
  const successRate = attempted ? succeeded / attempted : null;
  const health: 'HEALTHY' | 'DEGRADED' | 'FAILED' =
    attempted === 0
      ? 'DEGRADED'
      : succeeded === 0
        ? 'FAILED'
        : successRate! >= 0.95
          ? 'HEALTHY'
          : 'DEGRADED';
  return {
    health,
    attempted,
    succeeded,
    failed,
    successRate,
    p50LatencyMs: percentile(
      attempts.map((item) => item.latencyMs),
      0.5,
    ),
    p95LatencyMs: percentile(
      attempts.map((item) => item.latencyMs),
      0.95,
    ),
    provider429: attempts.filter((item) => item.httpStatus === 429).length,
    provider5xx: attempts.filter(
      (item) => item.httpStatus != null && item.httpStatus >= 500,
    ).length,
    timeouts: attempts.filter((item) =>
      /timeout|transport/i.test(`${item.errorCode} ${item.errorStage}`),
    ).length,
    schemaFailures: attempts.filter((item) =>
      /schema|json|parse/i.test(`${item.errorCode} ${item.errorStage}`),
    ).length,
  };
}

export function validateR2Analysis(
  value: unknown,
  packet?: AnalysisPacket,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object')
    throw new Error('schema_analysis_object_required');
  const item = value as Record<string, unknown>;
  if (item.stage !== 'postmatch') throw new Error('schema_stage_enum');
  if (
    typeof item.one_line_summary !== 'string' ||
    !item.one_line_summary.trim()
  )
    throw new Error('schema_one_line_summary_required');
  for (const field of [
    'what_happened',
    'three_signals',
    'map_reviews',
    'player_outliers',
    'hypotheses',
    'missing_evidence',
  ]) {
    if (!Array.isArray(item[field]))
      throw new Error(`schema_${field}_required`);
  }
  if (
    !(item.what_happened as unknown[]).length ||
    (item.what_happened as unknown[]).length > 5
  )
    throw new Error('schema_what_happened_count');
  if (
    !(item.three_signals as unknown[]).length ||
    (item.three_signals as unknown[]).length > 3
  )
    throw new Error('schema_three_signals_count');
  if ((item.map_reviews as unknown[]).length > 5)
    throw new Error('schema_map_reviews_max');
  if ((item.player_outliers as unknown[]).length > 4)
    throw new Error('schema_player_outliers_max');
  if ((item.hypotheses as unknown[]).length > 3)
    throw new Error('schema_hypotheses_max');
  const evidenceItems = item.what_happened as Array<Record<string, unknown>>;
  if (
    evidenceItems.some(
      (entry) =>
        !entry ||
        typeof entry.claim !== 'string' ||
        !Array.isArray(entry.evidence_ids) ||
        !entry.evidence_ids.length,
    )
  )
    throw new Error('schema_fact_evidence_required');
  if (
    item.research_queue !== null &&
    (typeof item.research_queue !== 'object' ||
      (item.research_queue as Record<string, unknown>).status !== 'NEW')
  )
    throw new Error('schema_research_queue');
  if (
    item.direct_probability_change_allowed !== false ||
    item.direct_training_allowed !== false ||
    item.direct_promotion_allowed !== false
  )
    throw new Error('schema_governance_const');
  if (packet?.reviewFocus === 'team_outcomes_v1') {
    const reviews = item.team_reviews as Array<Record<string, unknown>>;
    if (!Array.isArray(reviews) || reviews.length !== 2)
      throw new Error('schema_team_reviews_count');
    const names = new Set<string>();
    const facts = new Set(
      packet.evidenceReferences.filter((id) => id.startsWith('fact:')),
    );
    for (const review of reviews) {
      const team = review?.team;
      if (
        typeof team !== 'string' ||
        ![packet.prediction.teamA, packet.prediction.teamB].includes(team) ||
        names.has(team)
      )
        throw new Error('schema_team_review_identity');
      names.add(team);
      if (
        review.outcome !==
        (team === packet.prediction.actualWinner ? 'won' : 'lost')
      )
        throw new Error('schema_team_review_outcome');
      for (const field of ['strengths', 'weaknesses']) {
        const claims = review[field] as Array<Record<string, unknown>>;
        if (!Array.isArray(claims) || claims.length > 2)
          throw new Error('schema_team_review_claim_count');
        for (const claim of claims) {
          if (
            !claim ||
            typeof claim.claim !== 'string' ||
            !claim.claim.trim() ||
            claim.claim.length > 180
          )
            throw new Error('schema_team_review_claim');
          const refs = claim.evidence_ids;
          if (
            !Array.isArray(refs) ||
            !refs.length ||
            refs.length > 5 ||
            refs.some((ref) => typeof ref !== 'string' || !facts.has(ref))
          )
            throw new Error('schema_team_review_fact_reference');
        }
      }
      const explanation = review.possible_explanation as Record<
        string,
        unknown
      > | null;
      if (explanation !== null) {
        if (
          !explanation ||
          typeof explanation.claim !== 'string' ||
          !explanation.claim.trim() ||
          explanation.claim.length > 180
        )
          throw new Error('schema_team_explanation');
        const refs = explanation.evidence_ids;
        if (
          !Array.isArray(refs) ||
          !refs.length ||
          refs.length > 5 ||
          refs.some((ref) => typeof ref !== 'string' || !facts.has(ref))
        )
          throw new Error('schema_team_explanation_reference');
      }
    }
  }
  if (packet?.readerInsights)
    validateReaderReview(
      item.reader_review,
      packet.readerInsights,
      packet.evidenceReferences,
    );
  if (
    packet?.readerInsights &&
    item.reader_evidence_version === EVIDENCE_REVIEW_SCHEMA
  )
    validateEvidenceArticle(
      item,
      packet.readerInsights,
      [packet.prediction.teamA, packet.prediction.teamB],
      packet.evidenceReferences,
    );
}

export function validatePrematchAnalysis(
  value: unknown,
  input?: {
    factor_contributions?: Array<{ key: string; evidence_id: string }>;
    map_probabilities?: Array<{
      map: string;
      evidence_id: string;
      teamAProbability: number;
    }>;
    reader_context?: { recentMatches?: Array<{ reference: string }> };
  },
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object')
    throw new Error('schema_prematch_object_required');
  const item = value as Record<string, unknown>;
  if (item.stage !== 'prematch') throw new Error('schema_prematch_stage_enum');
  if (typeof item.summary !== 'string' || !item.summary.trim())
    throw new Error('schema_prematch_summary_required');
  if (
    typeof item.ai_probability_team_a !== 'number' ||
    item.ai_probability_team_a < 0.02 ||
    item.ai_probability_team_a > 0.98
  ) {
    throw new Error('schema_prematch_probability');
  }
  for (const field of [
    'key_factors',
    'risk_flags',
    'upset_conditions',
    'map_analysis',
  ]) {
    if (!Array.isArray(item[field]))
      throw new Error(`schema_prematch_${field}_required`);
  }
  if (item.direct_promotion_allowed !== false)
    throw new Error('schema_prematch_governance_const');
  if (input) {
    const factors = input.factor_contributions ?? [],
      maps = input.map_probabilities ?? [];
    const refs = new Set([
      ...factors.map((f) => f.evidence_id),
      ...maps.map((m) => m.evidence_id),
      ...(input.reader_context?.recentMatches?.map((m) => m.reference) ?? []),
    ]);
    for (const factor of item.key_factors as Array<Record<string, unknown>>) {
      const source = factors.find((f) => f.key === factor.factor);
      if (
        !source ||
        !Array.isArray(factor.evidence_ids) ||
        !factor.evidence_ids.includes(source.evidence_id) ||
        factor.evidence_ids.some((id) => !refs.has(id)) ||
        typeof factor.claim !== 'string' ||
        !['team_a', 'team_b', 'neutral'].includes(String(factor.direction))
      )
        throw new Error('schema_prematch_factor_binding');
    }
    for (const map of item.map_analysis as Array<Record<string, unknown>>) {
      const source = maps.find((m) => m.map === map.map);
      if (
        !source ||
        typeof map.team_a_probability !== 'number' ||
        Math.abs(map.team_a_probability - source.teamAProbability) > 1e-6 ||
        !Array.isArray(map.evidence_ids) ||
        !map.evidence_ids.includes(source.evidence_id) ||
        map.evidence_ids.some((id) => !refs.has(id))
      )
        throw new Error('schema_prematch_map_binding');
    }
  }
}
