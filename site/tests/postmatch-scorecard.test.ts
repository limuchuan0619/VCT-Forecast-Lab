import assert from 'node:assert/strict';
import test from 'node:test';
import { computePostmatchScorecard, validateActualScore, validateResultCorrection, validateResultEvidence } from '../lib/postmatch-scorecard.ts';
import type { PredictionSnapshot, ResultEvidenceEnvelope } from '../lib/vct-types.ts';

const prediction: PredictionSnapshot = {
  id: 'p1', source: 'system_auto', modelVersion: 'v1.0.0', lockedAt: '2026-09-05T08:00:00.000Z',
  scheduledAt: '2026-09-05T10:00:00.000Z', event: 'Test', region: 'CN', patch: null, seriesFormat: 'bo3',
  teamA: 'A', teamB: 'B', teamAProbability: 0.7, predictedScore: '2-0', status: 'locked', dataCutoffAt: '2026-09-05T07:59:00.000Z',
  factors: [], maps: [], scoreDistribution: { '2-0': 0.4, '2-1': 0.3, '1-2': 0.2, '0-2': 0.1 },
  evidence: { sourceLabel: 'test', patchProvenance: 'unavailable', qualityGate: 'ready' },
};

const resultEvidence: ResultEvidenceEnvelope = {
  schemaVersion: 'v1.4c-r1-result-evidence-v1',
  source: { sourceId: 'vlr', capturedAt: '2026-09-05T12:00:00.000Z' },
  series: { actualWinner: 'B', actualScore: '0-2', scheduledAt: prediction.scheduledAt, playedAt: prediction.scheduledAt, seriesFormat: 'bo3' },
  maps: [
    { order: 1, map: '升天之境', teamAScore: 7, teamBScore: 13, winner: 'B', missingFields: ['attack_defense'] },
    { order: 2, map: '隐世修所', teamAScore: 11, teamBScore: 13, winner: 'B', missingFields: ['attack_defense'] },
  ],
  playerStats: null,
  missing: { maps: false, playerStats: true, attackDefense: true, veto: true },
};

test('scorecard deterministically records reversal, probabilities and proper scores', () => {
  const scorecard = computePostmatchScorecard(prediction, 'B', '0-2');
  assert.equal(scorecard.winnerCorrect, false);
  assert.equal(scorecard.exactScoreCorrect, false);
  assert.equal(scorecard.directionReversal, true);
  assert.ok(Math.abs(scorecard.actualWinnerProbability - 0.3) < 1e-12);
  assert.ok(Math.abs(scorecard.actualScoreProbability! - 0.1) < 1e-12);
  assert.ok(Math.abs(scorecard.brierScore - 0.49) < 1e-12);
  assert.ok(Math.abs(scorecard.logLoss - -Math.log(0.3)) < 1e-12);
  assert.equal(scorecard.surpriseLevel, 'moderate');
});

test('series winner and score must agree with BO format', () => {
  assert.throws(() => validateActualScore(prediction, 'A', '0-2'), /winner_score_conflict/);
  assert.throws(() => validateActualScore(prediction, 'B', '0-3'), /invalid_actual_score_for_format/);
});

test('result evidence preserves missing player data instead of fabricating rows', () => {
  const validated = validateResultEvidence(prediction, 'B', '0-2', resultEvidence);
  assert.equal(validated.playerStats, null);
  assert.equal(validated.missing.playerStats, true);
  assert.equal(validated.maps[0].map, '升天之境');
});

test('result evidence cannot claim a pre-kickoff capture or malformed played time', () => {
  assert.throws(() => validateResultEvidence(prediction, 'B', '0-2', {
    ...resultEvidence,
    source: { ...resultEvidence.source, capturedAt: '2026-09-05T09:59:59.999Z' },
  }), /result_evidence_captured_before_scheduled/);
  assert.throws(() => validateResultEvidence(prediction, 'B', '0-2', {
    ...resultEvidence,
    series: { ...resultEvidence.series, playedAt: 'not-a-time' },
  }), /invalid_result_evidence_played_at/);
});

test('result evidence rejects live partial map panels and incomplete map counts', () => {
  assert.throws(() => validateResultEvidence(prediction, 'B', '0-2', {
    ...resultEvidence,
    maps: resultEvidence.maps.map((map, index) => index ? { ...map, teamAScore: 3, teamBScore: 6 } : map),
  }), /incomplete_result_map_score/);
  assert.throws(() => validateResultEvidence(prediction, 'B', '0-2', {
    ...resultEvidence,
    maps: resultEvidence.maps.slice(0, 1),
  }), /incomplete_result_map_evidence/);
});

test('controlled correction only accepts a newer complete snapshot from the same source', () => {
  const staleEvidence = {
    ...resultEvidence,
    source: { ...resultEvidence.source, sourceMatchId: 'vlr_match_1', sourceUrl: 'https://www.vlr.gg/1/x' },
    maps: resultEvidence.maps.map((map, index) => index ? { ...map, teamAScore: 3, teamBScore: 6 } : map),
  };
  const resolved: PredictionSnapshot = {
    ...prediction, status: 'resolved', actualWinner: 'B', actualScore: '0-2', resolvedAt: staleEvidence.source.capturedAt,
    resultEvidence: staleEvidence, scorecard: computePostmatchScorecard(prediction, 'B', '0-2'),
  };
  const corrected = {
    ...resultEvidence,
    source: { ...staleEvidence.source, capturedAt: '2026-09-05T13:00:00.000Z' },
  };
  assert.doesNotThrow(() => validateResultCorrection(resolved, 'B', '0-2', corrected));
  assert.throws(() => validateResultCorrection(resolved, 'B', '0-2', {
    ...corrected, source: { ...corrected.source, sourceMatchId: 'vlr_match_2' },
  }), /source_conflict/);
});

test('100 Thieves vs LOUD Map 5 partial panel is quarantined and a newer final may revise winner', () => {
  const bo5: PredictionSnapshot = {
    ...prediction, id: 'vlr-734308', seriesFormat: 'bo5', teamA: '100 Thieves', teamB: 'LOUD',
    predictedScore: '2-3', scoreDistribution: { '3-0': .1, '3-1': .1, '3-2': .2, '0-3': .1, '1-3': .2, '2-3': .3 },
  };
  const partial: ResultEvidenceEnvelope = {
    ...resultEvidence,
    source: { sourceId: 'vlr', sourceMatchId: '734308', sourceUrl: 'https://www.vlr.gg/734308/x', capturedAt: '2026-09-06T04:00:00.000Z' },
    series: { actualWinner: 'LOUD', actualScore: '2-3', scheduledAt: bo5.scheduledAt, playedAt: bo5.scheduledAt, seriesFormat: 'bo5' },
    maps: [
      { order: 1, map: '霓虹町', teamAScore: 7, teamBScore: 13, winner: 'LOUD', missingFields: [] },
      { order: 2, map: '日落之城', teamAScore: 13, teamBScore: 11, winner: '100 Thieves', missingFields: [] },
      { order: 3, map: '升天之境', teamAScore: 14, teamBScore: 12, winner: '100 Thieves', missingFields: [] },
      { order: 4, map: '天枢云阙', teamAScore: 1, teamBScore: 13, winner: 'LOUD', missingFields: [] },
      { order: 5, map: '隐世修所', teamAScore: 5, teamBScore: 7, winner: 'LOUD', missingFields: [] },
    ],
    missing: { maps: false, playerStats: true, attackDefense: true, veto: true }, playerStats: null,
  };
  assert.throws(() => validateResultEvidence(bo5, 'LOUD', '2-3', partial), /incomplete_result_map_score/);
  const resolved: PredictionSnapshot = {
    ...bo5, status: 'resolved', actualWinner: 'LOUD', actualScore: '2-3', resolvedAt: partial.source.capturedAt,
    resultEvidence: partial, scorecard: computePostmatchScorecard(bo5, 'LOUD', '2-3'),
  };
  const finalEvidence: ResultEvidenceEnvelope = {
    ...partial,
    source: { ...partial.source, capturedAt: '2026-09-06T04:10:00.000Z' },
    series: { ...partial.series, actualWinner: '100 Thieves', actualScore: '3-2' },
    maps: partial.maps.map((map, index) => index === 4
      ? { ...map, teamAScore: 14, teamBScore: 12, winner: '100 Thieves' }
      : map),
  };
  assert.doesNotThrow(() => validateResultCorrection(resolved, '100 Thieves', '3-2', finalEvidence));
});

test('map winners must reconstruct BO3 and BO5 series score', () => {
  assert.throws(() => validateResultEvidence(prediction, 'B', '0-2', {
    ...resultEvidence,
    maps: resultEvidence.maps.map((map, index) => index === 0 ? { ...map, teamAScore: 13, teamBScore: 11, winner: 'A' } : map),
  }), /result_map_series_inconsistent/);
});
