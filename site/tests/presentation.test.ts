import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjacentDay,
  chinaDay,
  tomorrowChinaDay,
  validDay,
  matchesOnDay,
  modelProbabilities,
  evaluateModels,
  resultSentence,
  reviewSummary,
  plainText,
  comparisonCoverage,
  largestDisagreements,
} from '../lib/presentation.ts';
import {
  frozenFactorReading,
  prematchReading,
  evidenceItem,
  postmatchPacketMatchesRecord,
} from '../lib/evidence-presentation.ts';
import { buildAnalysisPacket } from '../lib/ai-reliability.ts';
import {
  historyPage,
  chinaDayRange,
  predictionSelection,
} from '../lib/history-query.ts';
import { computePostmatchScorecard } from '../lib/postmatch-scorecard.ts';
import type {
  PredictionRecord,
  ChallengerPrediction,
} from '../lib/vct-types.ts';

function fixture(): PredictionRecord {
  const r: PredictionRecord = {
    id: 'p1',
    source: 'system_auto',
    modelVersion: 'v1.0.0',
    lockedAt: '2026-10-03T01:00:00Z',
    scheduledAt: '2026-10-04T05:00:00Z',
    event: 'ISOLATED TEST',
    region: 'CN',
    seriesFormat: 'bo3',
    teamA: 'A',
    teamB: 'B',
    teamAProbability: 0.6,
    predictedScore: '2-0',
    status: 'resolved',
    actualWinner: 'B',
    actualScore: '0-2',
    dataCutoffAt: '2026-10-03T00:59:00Z',
    factors: [],
    maps: [],
    scoreDistribution: { '2-0': 0.6, '0-2': 0.4 },
    evidence: {
      sourceLabel: 'isolated',
      patchProvenance: 'event_cohort',
      qualityGate: 'ready',
    },
    prematchAiCreatedAt: '2026-10-03T02:00:00Z',
    prematchAiModelId: 'test-deepseek',
    prematchAnalysis: {
      stage: 'prematch',
      ai_probability_team_a: 0.55,
      predicted_score: '2-1',
      summary: 'test',
      key_factors: [],
      risk_flags: [],
      upset_conditions: [],
      model_disagreement: 'test',
      optimization_hypotheses: [],
      direct_promotion_allowed: false,
    },
  };
  r.resultEvidence = {
    schemaVersion: 'v1.4c-r1-result-evidence-v1',
    source: { sourceId: 'test', capturedAt: '2026-10-04T09:00:00Z' },
    series: {
      actualWinner: 'B',
      actualScore: '0-2',
      scheduledAt: r.scheduledAt,
      seriesFormat: 'bo3',
    },
    maps: [1, 2].map((order) => ({
      order,
      map: '莲华古城',
      teamAScore: 8,
      teamBScore: 13,
      winner: 'B',
      missingFields: [],
    })),
    playerStats: null,
    missing: {
      maps: false,
      playerStats: true,
      attackDefense: true,
      veto: true,
    },
  };
  r.scorecard = computePostmatchScorecard(r, 'B', '0-2');
  r.challenger = {
    id: 'c1',
    fixtureId: 'f1',
    championPredictionId: r.id,
    featureSnapshotId: 's1',
    featureSnapshotHash: 'a'.repeat(64),
    features: {},
    featureStatus: {},
    evidence: {},
    frozenAt: r.lockedAt,
    scheduledAt: r.scheduledAt,
    championModelVersion: r.modelVersion,
    championProbability: 0.6,
    challengerModelId: 'logistic_c1_v1.4b_20260903',
    datasetVersion: 'v1.4b-c1-20260903',
    artifactHash: 'b'.repeat(64),
    challengerProbability: 0.4,
    probabilityDelta: -0.2,
    dataQualityState: 'ready',
    recordKind: 'real_prospective',
    eligible: true,
    status: 'resolved',
    actualWinner: 'B',
  } satisfies ChallengerPrediction;
  return r;
}

test('Beijing calendar selection is not UTC or rolling 48 hours', () => {
  assert.equal(chinaDay('2026-10-03T16:01:00Z'), '2026-10-04');
  assert.equal(
    tomorrowChinaDay(Date.parse('2026-10-03T16:01:00Z')),
    '2026-10-05',
  );
  assert.equal(adjacentDay('2026-12-31', 1), '2027-01-01');
  assert.equal(validDay('2026-02-30'), false);
  assert.equal(validDay('2026-10-04'), true);
  const r = fixture();
  assert.equal(matchesOnDay([r], '2026-10-04').length, 1);
  assert.equal(matchesOnDay([r], '2026-10-03').length, 0);
});
test('winner-oriented score and deterministic summary do not mutate original score or AI text', () => {
  const r = fixture(),
    before = JSON.stringify(r);
  assert.equal(resultSentence(r), 'B 2:0 击败 A');
  assert.match(reviewSummary(r), /胜者判断未命中/);
  assert.equal(JSON.stringify(r), before);
  assert.equal(
    plainText('team_b Rating 与 MODEL SIGNAL', r),
    'B 实力评分 与 赛前判断依据',
  );
});
test('all probabilities refer to the same first team, not each favored team', () => {
  assert.deepEqual(modelProbabilities(fixture()), {
    champion: 0.6,
    c1: 0.4,
    deepseek: 0.55,
  });
});
test('postkickoff, exactly-kickoff, missing timestamp and missing identity AI cannot enter comparison', () => {
  for (const time of [
    null,
    '2026-10-04T05:00:00Z',
    '2026-10-04T06:00:00Z',
    'bad',
  ]) {
    const r = fixture();
    r.prematchAiCreatedAt = time;
    assert.equal(modelProbabilities(r).deepseek, null);
  }
  const r = fixture();
  r.prematchAiModelId = null;
  assert.equal(modelProbabilities(r).deepseek, null);
});
test('invalid or absent probabilities never turn into zero or 50%', () => {
  for (const value of [NaN, 0, 1, 1.1]) {
    const r = fixture();
    r.prematchAnalysis!.ai_probability_team_a = value;
    assert.equal(modelProbabilities(r).deepseek, null);
  }
  const r = fixture();
  r.prematchAnalysis = null;
  r.challenger = null;
  assert.deepEqual(modelProbabilities(r), {
    champion: 0.6,
    c1: null,
    deepseek: null,
  });
});
test('historical, isolated, blocked, mismatched snapshot and different C1 identities do not count', () => {
  for (const mutate of [
    (r: PredictionRecord) => {
      r.source = 'human_archive';
    },
    (r: PredictionRecord) => {
      r.source = 'system_historical_replay';
    },
    (r: PredictionRecord) => {
      r.challenger!.recordKind = 'isolated_test';
    },
    (r: PredictionRecord) => {
      r.challenger!.eligible = false;
    },
    (r: PredictionRecord) => {
      r.challenger!.frozenAt = '2026-10-03T03:00:00Z';
    },
    (r: PredictionRecord) => {
      r.challenger!.championProbability = 0.7;
    },
    (r: PredictionRecord) => {
      r.challenger!.challengerModelId = 'c2';
    },
  ]) {
    const r = fixture();
    mutate(r);
    assert.equal(
      evaluateModels([r], ['champion', 'c1', 'deepseek']).matches,
      0,
    );
  }
});
test('only consistent resolved frozen pairs count once per fixture', () => {
  const r = fixture();
  assert.equal(
    evaluateModels([r, { ...r, id: 'duplicate' }], ['champion', 'c1']).matches,
    1,
  );
  for (const mutate of [
    (p: PredictionRecord) => {
      p.status = 'locked';
    },
    (p: PredictionRecord) => {
      p.challenger!.status = 'locked';
    },
    (p: PredictionRecord) => {
      p.challenger!.actualWinner = 'A';
    },
    (p: PredictionRecord) => {
      p.resultEvidence = null;
    },
    (p: PredictionRecord) => {
      p.scorecard!.actualScore = '2-0';
    },
  ]) {
    const p = fixture();
    mutate(p);
    assert.equal(evaluateModels([p], ['champion', 'c1']).matches, 0);
  }
});
test('common intersection is fair; pair sample counts are separate and zero sample has no metrics', () => {
  const r = fixture(),
    missing = fixture();
  missing.id = 'p2';
  missing.challenger!.fixtureId = 'f2';
  missing.challenger!.championPredictionId = 'p2';
  missing.prematchAiCreatedAt = null;
  assert.equal(
    evaluateModels([r, missing], ['champion', 'c1', 'deepseek']).matches,
    1,
  );
  assert.equal(evaluateModels([r, missing], ['champion', 'c1']).matches, 2);
  assert.deepEqual(evaluateModels([], ['champion', 'c1', 'deepseek']), {
    matches: 0,
    metrics: {},
  });
});
test('Brier, log loss, accuracy and calibration are computed on the same samples', () => {
  const report = evaluateModels([fixture()], ['champion', 'c1', 'deepseek']);
  assert.equal(report.metrics.champion!.brier, 0.36);
  assert.equal(report.metrics.champion!.accuracy, 0);
  assert.ok(Math.abs(report.metrics.c1!.brier - 0.16) < 1e-12);
  assert.equal(report.metrics.c1!.accuracy, 1);
  assert.equal(report.metrics.champion!.logLoss, -Math.log(0.4));
  assert.equal(report.metrics.champion!.ece, 0.6);
  assert.equal(report.metrics.champion!.highConfidenceAccuracy, null);
});
test('settling or revising a result cannot regenerate or change frozen probabilities', () => {
  const r = fixture(),
    before = modelProbabilities(r);
  r.actualWinner = 'A';
  r.actualScore = '2-0';
  assert.deepEqual(modelProbabilities(r), before);
  assert.equal(evaluateModels([r], ['champion', 'c1', 'deepseek']).matches, 0);
});

test('day selection is exclusive at Beijing midnight and parameters never become SQL', () => {
  assert.deepEqual(chinaDayRange('2026-10-04'), [
    '2026-10-03T16:00:00.000Z',
    '2026-10-04T16:00:00.000Z',
  ]);
  assert.throws(() => chinaDayRange('2026-02-30'));
  assert.equal(historyPage('-1'), 1);
  assert.equal(historyPage('2'), 2);
  assert.equal(historyPage('1 OR 1=1'), 1);
  assert.equal(historyPage('99999999999'), 1);
  assert.throws(() => predictionSelection({ region: "CN' OR 1=1" }));
  const query = predictionSelection({
    day: '2026-10-04',
    region: 'CN',
    resolvedOnly: true,
  });
  assert.match(query.where, /scheduled_at\)<datetime\(\?\)/);
  assert.deepEqual(query.values, [
    '2026-10-03T16:00:00.000Z',
    '2026-10-04T16:00:00.000Z',
    'CN',
  ]);
});

test('prematch reasons expose frozen values and do not change with result or AI hypotheses', () => {
  const r = fixture();
  r.evidence.patchProvenance = 'event_cohort';
  r.factors = [
    {
      key: 'team_rating',
      rank: 2,
      label: 'Rating',
      detail: 'A 1600.000 / B 1500.000 · rating_points',
      probabilityPoints: 8,
      absoluteShare: 0.8,
    },
    {
      key: 'recent_form',
      rank: 1,
      label: '近期状态',
      detail: 'A -0.300 / B 0.500 · normalized',
      probabilityPoints: -2,
      absoluteShare: 0.2,
    },
  ];
  r.maps = [
    {
      map: '天枢云阙',
      teamAProbability: 0.6,
      teamBProbability: 0.4,
      samples: [2, 8],
    },
  ];
  const saved = JSON.stringify(r),
    before = prematchReading(r);
  assert.equal(before.supports[0].key, 'team_rating');
  assert.equal(before.counters[0].key, 'recent_form');
  assert.match(frozenFactorReading(r.factors[0], r), /1600\.0/);
  assert.ok(before.warnings.some((w) => w.includes('2 / 8')));
  assert.ok(before.warnings.some((w) => w.includes('不是真实游戏版本')));
  assert.equal(JSON.stringify(r), saved);
  r.actualWinner = 'A';
  r.actualScore = '2-0';
  assert.deepEqual(prematchReading(r), before);
});

test('exact 50 percent and missing evidence do not manufacture favored sides or facts', () => {
  const r = fixture();
  r.teamAProbability = 0.5;
  assert.equal(prematchReading(r).favored, null);
  assert.deepEqual(prematchReading(r).supports, []);
  assert.equal(evidenceItem(r, 'fact:map:1').kind, 'missing');
  assert.equal(evidenceItem(r, 'fact:player:1:invented').kind, 'missing');
  assert.equal(evidenceItem(r, 'prediction:locked_snapshot').kind, 'prematch');
});

test('AI citations resolve only from the actual packet and reject revised or unlisted evidence', () => {
  const r = fixture();
  r.postmatchEvidence = buildAnalysisPacket(r);
  assert.equal(postmatchPacketMatchesRecord(r.postmatchEvidence, r), true);
  assert.equal(evidenceItem(r, 'fact:map:1').kind, 'postmatch');
  assert.match(evidenceItem(r, 'fact:map:1').text, /8:13/);
  assert.equal(evidenceItem(r, 'fact:map:9').kind, 'missing');
  assert.equal(evidenceItem(r, 'system:scorecard').kind, 'model');
  r.resultEvidence!.source.capturedAt = '2026-10-05T00:00:00Z';
  assert.equal(postmatchPacketMatchesRecord(r.postmatchEvidence, r), false);
  assert.equal(evidenceItem(r, 'fact:map:1').kind, 'missing');
  assert.equal(evidenceItem(r, 'prediction:locked_snapshot').kind, 'prematch');
});

test('comparison coverage and disagreement highlights do not cherry pick evaluation samples', () => {
  const r = fixture(),
    missing = fixture(),
    pending = fixture();
  missing.id = 'p2';
  missing.challenger!.fixtureId = 'f2';
  missing.challenger!.championPredictionId = 'p2';
  missing.prematchAiCreatedAt = null;
  pending.id = 'p3';
  pending.status = 'locked';
  const records = [r, missing, pending],
    models = ['champion', 'c1', 'deepseek'] as const;
  const before = evaluateModels(records, [...models]);
  const coverage = comparisonCoverage(records, [...models]);
  assert.deepEqual(
    [coverage.total, coverage.pending, coverage.resolved, coverage.eligible],
    [3, 1, 2, 1],
  );
  assert.equal(coverage.missing.deepseek, 1);
  assert.equal(largestDisagreements(records, [...models])[0].record.id, 'p1');
  assert.deepEqual(evaluateModels(records, [...models]), before);
});
