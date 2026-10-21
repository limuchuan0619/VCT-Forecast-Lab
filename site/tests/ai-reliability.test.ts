import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertJobTransition,
  buildAnalysisPacket,
  canonicalJson,
  classifyAiFailure,
  evidenceGrade,
  logicalJobKey,
  matchesArchivedResultDelivery,
  packetWithHashes,
  POSTMATCH_JOB_PROMPT_VERSION,
  POSTMATCH_R2_REASONING_EFFORT,
  providerHealth,
  retrySchedule,
  sameFrozenMapSnapshot,
  sameFrozenResultEvidence,
  sha256,
  validateR2Analysis,
} from '../lib/ai-reliability.ts';
import type { PredictionSnapshot } from '../lib/vct-types.ts';

function prediction(
  format: 'bo3' | 'bo5',
  mapCount: number,
): PredictionSnapshot {
  const maps = Array.from({ length: mapCount }, (_, index) => ({
    order: index + 1,
    map: index === mapCount - 1 ? 'summit' : `地图${index + 1}`,
    teamAScore: 13,
    teamBScore: 9,
    winner: 'A',
    missingFields: ['attack_defense'],
  }));
  const players = maps.flatMap((map) => [
    {
      mapOrder: map.order,
      playerId: `a${map.order}`,
      player: `A${map.order}`,
      teamId: 'ta',
      agent: 'jett',
      rating: 1.2,
      acs: 240,
      kills: 20,
      deaths: 12,
      assists: 4,
      kast: 0.8,
      adr: 155,
      hsPct: 0.3,
      firstKills: 4,
      firstDeaths: 1,
    },
    {
      mapOrder: map.order,
      playerId: `b${map.order}`,
      player: `B${map.order}`,
      teamId: 'tb',
      agent: null,
      rating: 0.8,
      acs: null,
      kills: 12,
      deaths: 20,
      assists: 2,
      kast: null,
      adr: 95,
      hsPct: 0.2,
      firstKills: 1,
      firstDeaths: 4,
    },
  ]);
  return {
    id: `p-${format}`,
    source: 'system_auto',
    modelVersion: 'v1.0.0',
    lockedAt: '2026-09-01T00:00:00Z',
    scheduledAt: '2026-09-02T00:00:00Z',
    event: 'event',
    region: 'CN',
    seriesFormat: format,
    teamA: 'A',
    teamB: 'B',
    teamAProbability: 0.61,
    predictedScore: format === 'bo3' ? '2-1' : '3-1',
    status: 'resolved',
    actualWinner: 'A',
    actualScore: format === 'bo3' ? '2-1' : '3-2',
    resolvedAt: '2026-09-02T02:00:00Z',
    dataCutoffAt: '2026-09-01T00:00:00Z',
    factors: [
      {
        key: 'team_rating',
        rank: 1,
        label: 'Rating',
        detail: 'A > B',
        probabilityPoints: 11,
        absoluteShare: 0.7,
      },
      {
        key: 'recent_form',
        rank: 2,
        label: 'Form',
        detail: 'A < B',
        probabilityPoints: -4,
        absoluteShare: 0.3,
      },
    ],
    maps: maps.map((map) => ({
      map: map.map === 'summit' ? '天枢云阙' : map.map,
      teamAProbability: 0.6,
      teamBProbability: 0.4,
      teamAMapRating: 1580,
      teamBMapRating: 1520,
      samples: [10, 10],
    })),
    scoreDistribution:
      format === 'bo3'
        ? { '2-0': 0.3, '2-1': 0.31, '0-2': 0.19, '1-2': 0.2 }
        : {
            '3-0': 0.2,
            '3-1': 0.21,
            '3-2': 0.2,
            '0-3': 0.1,
            '1-3': 0.14,
            '2-3': 0.15,
          },
    evidence: {
      sourceLabel: 'VLR',
      patchProvenance: 'event_cohort',
      qualityGate: 'ready',
    },
    resultEvidence: {
      schemaVersion: 'v1.4c-r1-result-evidence-v1',
      source: { sourceId: 'vlr', capturedAt: '2026-09-02T02:00:00Z' },
      series: {
        actualWinner: 'A',
        actualScore: format === 'bo3' ? '2-1' : '3-2',
        scheduledAt: '2026-09-02T00:00:00Z',
        seriesFormat: format,
      },
      maps,
      playerStats: players,
      missing: {
        maps: false,
        playerStats: false,
        attackDefense: true,
        veto: true,
      },
    },
    scorecard: {
      schemaVersion: 'v1.4c-r1-scorecard-v1',
      thresholdVersion: 'v1.4c-r1-surprise-thresholds-v1',
      predictedWinner: 'A',
      actualWinner: 'A',
      winnerCorrect: true,
      predictedScore: format === 'bo3' ? '2-1' : '3-1',
      actualScore: format === 'bo3' ? '2-1' : '3-2',
      exactScoreCorrect: format === 'bo3',
      actualWinnerProbability: 0.61,
      actualScoreProbability: 0.3,
      brierScore: 0.1521,
      logLoss: 0.494,
      winnerSurprisal: 0.494,
      scorelineSurprisal: 1.2,
      directionReversal: false,
      surpriseLevel: 'low',
    },
  };
}

test('provider failures are classified into the required operational buckets', () => {
  assert.equal(
    classifyAiFailure({ message: 'rate limit', httpStatus: 429 }).category,
    'PROVIDER_429',
  );
  assert.equal(
    classifyAiFailure({ message: 'server', httpStatus: 500 }).category,
    'PROVIDER_5XX',
  );
  assert.equal(
    classifyAiFailure(new Error('request timeout')).category,
    'TIMEOUT_CONNECTION',
  );
  assert.equal(
    classifyAiFailure(new Error('Unterminated string in JSON')).category,
    'INVALID_JSON',
  );
  assert.equal(
    classifyAiFailure(new Error('required schema field')).category,
    'SCHEMA_VALIDATION',
  );
  assert.equal(
    classifyAiFailure(new Error('deepseek_incomplete_max_output_tokens'))
      .category,
    'PAYLOAD_CONTEXT',
  );
  assert.equal(
    classifyAiFailure(new Error('database unique constraint')).category,
    'DB_WRITE_DUPLICATE',
  );
});

test('only transient provider and transport failures retry', () => {
  assert.equal(
    classifyAiFailure({ message: '429', httpStatus: 429 }).retryable,
    true,
  );
  assert.equal(classifyAiFailure(new Error('invalid JSON')).retryable, true);
  assert.equal(
    classifyAiFailure(new Error('required schema field')).retryable,
    false,
  );
});

test('R2 structured extraction preserves visible JSON budget by disabling hidden reasoning', () => {
  assert.equal(POSTMATCH_R2_REASONING_EFFORT, 'none');
  assert.equal(
    POSTMATCH_JOB_PROMPT_VERSION,
    'vct-postmatch-deepseek-v18-evidence1',
  );
});

test('additive map ratings never mutate or conflict with an older frozen map snapshot', () => {
  const frozen = [
    {
      map: '天枢云阙',
      teamAProbability: 0.6,
      teamBProbability: 0.4,
      samples: [5, 4] as [number, number],
    },
  ];
  const enriched = [
    { ...frozen[0], teamAMapRating: 1580, teamBMapRating: 1510 },
  ];
  assert.equal(sameFrozenMapSnapshot(frozen, enriched), true);
  assert.equal(
    sameFrozenMapSnapshot(frozen, [{ ...enriched[0], teamAProbability: 0.61 }]),
    false,
  );
  assert.equal(
    sameFrozenMapSnapshot(enriched, [{ ...enriched[0], teamAMapRating: 1590 }]),
    false,
  );
});

test('result redelivery may change observation time but never competition facts', () => {
  const frozen = prediction('bo3', 3).resultEvidence!;
  const redelivered = {
    ...frozen,
    source: { ...frozen.source, capturedAt: '2026-09-03T00:00:00Z' },
  };
  assert.equal(sameFrozenResultEvidence(frozen, redelivered), true);
  assert.equal(
    sameFrozenResultEvidence(frozen, {
      ...redelivered,
      series: { ...redelivered.series, actualScore: '0-2' },
    }),
    false,
  );
  assert.equal(
    sameFrozenResultEvidence(frozen, {
      ...redelivered,
      maps: redelivered.maps.map((map, index) =>
        index ? map : { ...map, teamAScore: 12 },
      ),
    }),
    false,
  );
  assert.equal(
    matchesArchivedResultDelivery(
      { winner: 'B', score: '0-2', evidence: frozen },
      { winner: 'B', score: '0-2', evidence: redelivered },
    ),
    true,
  );
  assert.equal(
    matchesArchivedResultDelivery(
      { winner: 'B', score: '0-2', evidence: frozen },
      { winner: 'A', score: '2-0', evidence: redelivered },
    ),
    false,
  );
});

test('retry schedule is versionable and terminal after five attempts', () => {
  assert.equal(
    retrySchedule(1, '2026-09-01T00:00:00Z').nextRetryAt,
    '2026-09-01T00:05:00.000Z',
  );
  assert.equal(
    retrySchedule(4, '2026-09-01T00:00:00Z').nextRetryAt,
    '2026-09-01T12:00:00.000Z',
  );
  assert.deepEqual(retrySchedule(5, '2026-09-01T00:00:00Z'), {
    status: 'FINAL_FAILED',
    nextRetryAt: null,
  });
});

test('state machine rejects illegal mutation after success and allows retry path', () => {
  assert.doesNotThrow(() => assertJobTransition('PENDING', 'RUNNING'));
  assert.doesNotThrow(() => assertJobTransition('RUNNING', 'RETRYABLE_FAILED'));
  assert.doesNotThrow(() =>
    assertJobTransition('RETRYABLE_FAILED', 'RETRY_SCHEDULED'),
  );
  assert.throws(() => assertJobTransition('SUCCESS', 'RUNNING'));
});

test('three-map BO3 packet keeps map, player null and unsupported boundaries explicit', () => {
  const packet = buildAnalysisPacket(prediction('bo3', 3));
  assert.equal(packet.maps.length, 3);
  assert.equal(packet.maps[2].map, '天枢云阙');
  assert.equal(packet.maps[0].teamAMapRating, 1580);
  assert.equal(packet.maps[0].teamBMapRating, 1520);
  assert.equal(packet.coverage.mapsPlayed, 3);
  assert.equal(packet.coverage.veto, false);
  assert.equal(packet.evidenceGrade, 'B');
  assert.equal(packet.missingEvidence.includes('round_timeline'), true);
  const nullMetric = packet.playerOutliers
    .flatMap((row) => Object.values(row.metrics))
    .find((item) => item.status === 'missing');
  assert.equal(nullMetric?.value, null);
});

test('five-map BO5 packet retains all maps and never calls event cohort a real patch', () => {
  const packet = buildAnalysisPacket(prediction('bo5', 5));
  assert.equal(packet.maps.length, 5);
  assert.equal(canonicalJson(packet).includes('real_patch'), false);
});

test('factor conflict matrix is deterministic and descriptive, not causal', () => {
  const matrix = buildAnalysisPacket(prediction('bo3', 3)).factorConflictMatrix;
  assert.equal(matrix[0].resultRelation, 'supported');
  assert.equal(matrix[1].resultRelation, 'contradicted');
});

test('raw evidence and bounded packet receive stable distinct hashes across restart', async () => {
  const item = prediction('bo3', 3);
  const before = await packetWithHashes(item);
  const serialized = JSON.parse(JSON.stringify(item));
  const after = await packetWithHashes(serialized);
  assert.equal(before.rawEvidenceHash, after.rawEvidenceHash);
  assert.equal(before.analysisPacketHash, after.analysisPacketHash);
  assert.notEqual(before.rawEvidenceHash, before.analysisPacketHash);
});

test('logical key prevents duplicate jobs for the same prompt and schema', () => {
  assert.equal(
    logicalJobKey('p', 'postmatch', 'v4', 's1'),
    logicalJobKey('p', 'postmatch', 'v4', 's1'),
  );
  assert.notEqual(
    logicalJobKey('p', 'postmatch', 'v4', 's1'),
    logicalJobKey('p', 'postmatch', 'v5', 's1'),
  );
});

test('R2 schema accepts success and rejects invalid JSON-shaped output', () => {
  const valid = {
    stage: 'postmatch',
    one_line_summary: 'x',
    what_happened: [{ claim: 'A won', evidence_ids: ['fact:result'] }],
    three_signals: [
      {
        signal: 'rating',
        relation: 'supported_result',
        evidence_ids: ['factor:rating'],
      },
    ],
    map_reviews: [],
    player_outliers: [],
    hypotheses: [],
    missing_evidence: [],
    research_queue: null,
    direct_probability_change_allowed: false,
    direct_training_allowed: false,
    direct_promotion_allowed: false,
  };
  assert.doesNotThrow(() => validateR2Analysis(valid));
  assert.throws(() =>
    validateR2Analysis({ ...valid, direct_training_allowed: true }),
  );
  assert.throws(() =>
    validateR2Analysis({ ...valid, three_signals: [1, 2, 3, 4] }),
  );
});

test('evidence grade is deterministic A through D', () => {
  assert.equal(
    evidenceGrade({
      series: true,
      maps: true,
      players: true,
      veto: true,
      roster: true,
    }),
    'A',
  );
  assert.equal(
    evidenceGrade({
      series: true,
      maps: true,
      players: true,
      veto: false,
      roster: true,
    }),
    'B',
  );
  assert.equal(
    evidenceGrade({
      series: true,
      maps: true,
      players: false,
      veto: false,
      roster: false,
    }),
    'C',
  );
  assert.equal(
    evidenceGrade({
      series: true,
      maps: false,
      players: false,
      veto: false,
      roster: false,
    }),
    'D',
  );
});

test('provider observability computes health and failure counters', () => {
  const rows = [
    {
      status: 'SUCCESS' as const,
      requestStartedAt: 'x',
      latencyMs: 100,
      httpStatus: 200,
    },
    {
      status: 'FAILED' as const,
      requestStartedAt: 'x',
      latencyMs: 200,
      httpStatus: 429,
      errorStage: 'provider',
      errorCode: 'PROVIDER_429',
    },
  ];
  const result = providerHealth(rows);
  assert.equal(result.health, 'DEGRADED');
  assert.equal(result.provider429, 1);
  assert.equal(result.p95LatencyMs, 200);
});

test('AI packet governance cannot change probability, train or promote', () => {
  const before = prediction('bo3', 3);
  const probability = before.teamAProbability;
  const packet = buildAnalysisPacket(before);
  assert.deepEqual(packet.governance, {
    aiMayRecomputeFormalMetrics: false,
    aiMayChangeProbability: false,
    aiMayTrainModel: false,
    aiMayPromoteModel: false,
    causalStatementsMustBeHypotheses: true,
  });
  assert.equal(before.teamAProbability, probability);
});

test('canonical hashing ignores object key order but not content', async () => {
  assert.equal(await sha256({ a: 1, b: 2 }), await sha256({ b: 2, a: 1 }));
  assert.notEqual(await sha256({ a: 1 }), await sha256({ a: 2 }));
});

test('large player evidence is deterministically reduced to a bounded AI packet', () => {
  const item = prediction('bo5', 5);
  const original = item.resultEvidence!.playerStats as Array<
    Record<string, unknown>
  >;
  item.resultEvidence!.playerStats = Array.from({ length: 5 }, (_, copy) =>
    original.map((row, index) => ({
      ...row,
      playerId: `${String(row.playerId)}-copy-${copy}`,
      player: `${String(row.player)}-copy-${copy}`,
      acs: typeof row.acs === 'number' ? row.acs + copy + index : null,
    })),
  ).flat();
  const packet = buildAnalysisPacket(item);
  assert.equal(packet.coverage.playerRows, 50);
  assert.equal(packet.playerOutliers.length, 4);
  assert.ok(canonicalJson(packet).length < 30_000);
});

test('player baseline and roster mismatch stay unavailable when no frozen prematch evidence exists', () => {
  const packet = buildAnalysisPacket(prediction('bo3', 3));
  assert.ok(
    packet.playerOutliers.every(
      (row) => row.baselineStatus === 'unavailable_not_frozen',
    ),
  );
  assert.equal(packet.roster.mismatchStatus, 'unavailable_not_frozen');
  assert.equal(packet.coverage.rosterExpectedFrozen, false);
});

test('independent jobs allow later match B to succeed before retried match A', () => {
  assert.doesNotThrow(() => assertJobTransition('PENDING', 'RUNNING'));
  assert.doesNotThrow(() => assertJobTransition('RUNNING', 'RETRYABLE_FAILED'));
  assert.doesNotThrow(() =>
    assertJobTransition('RETRYABLE_FAILED', 'RETRY_SCHEDULED'),
  );
  assert.doesNotThrow(() => assertJobTransition('PENDING', 'RUNNING'));
  assert.doesNotThrow(() => assertJobTransition('RUNNING', 'SUCCESS'));
  assert.doesNotThrow(() => assertJobTransition('RETRY_SCHEDULED', 'RUNNING'));
  assert.doesNotThrow(() => assertJobTransition('RUNNING', 'SUCCESS'));
});
