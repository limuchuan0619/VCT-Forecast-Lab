import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnalysisPacket,
  validateR2Analysis,
} from '../lib/ai-reliability.ts';
import {
  mapExpectationChecks,
  teamResults,
  verifiedTeamReviews,
} from '../lib/match-review.ts';
import { reviewFixture } from './fixtures/match-review.ts';

test('both teams retain wins and losses in BO3/BO5 with team-B-oriented score', () => {
  const bo3 = teamResults(reviewFixture());
  assert.deepEqual(
    bo3.map((item) => [
      item.team,
      item.outcome,
      item.wonMaps.length,
      item.lostMaps.length,
    ]),
    [
      ['A', 'lost', 1, 2],
      ['B', 'won', 2, 1],
    ],
  );
  assert.equal(bo3[1].wonMaps[0].score, '8:13');
  assert.deepEqual(
    teamResults(reviewFixture('bo5')).map((item) => item.wonMaps.length),
    [3, 2],
  );
});

test('actual maps compare only frozen named candidates; 50/50 and missing stay explicit', () => {
  const item = reviewFixture();
  item.maps[1].teamAProbability = 0.5;
  item.maps = item.maps.slice(0, 2);
  const before = JSON.stringify(item);
  assert.deepEqual(
    mapExpectationChecks(item).map((map) => map.assessment),
    ['matched', 'close', 'unavailable'],
  );
  assert.equal(mapExpectationChecks(item)[2].probabilityTeamA, null);
  assert.equal(JSON.stringify(item), before);
  item.maps[0].teamAProbability = Number.NaN;
  assert.equal(mapExpectationChecks(item)[0].assessment, 'unavailable');
});

test('missing results or unsettled predictions cannot manufacture team outcomes', () => {
  const item = reviewFixture();
  item.resultEvidence = null;
  assert.deepEqual(teamResults(item), []);
  item.status = 'locked';
  assert.deepEqual(teamResults(item), []);
});

test('only two team reviews bound to current evidence can enter the primary section', () => {
  const item = reviewFixture();
  assert.equal(verifiedTeamReviews(item).length, 2);
  item.resultEvidence!.source.capturedAt = '2026-09-03T00:00:00Z';
  assert.deepEqual(verifiedTeamReviews(item), []);
  item.postmatchEvidence = buildAnalysisPacket(item);
  item.postmatchReview!.team_reviews![1].strengths[0].evidence_ids = [
    'fact:map:99',
  ];
  assert.deepEqual(verifiedTeamReviews(item), []);
});

test('new output rejects invented refs, wrong winners, duplicate teams and model signals used as facts', () => {
  const item = reviewFixture();
  assert.doesNotThrow(() =>
    validateR2Analysis(item.postmatchReview, item.postmatchEvidence!),
  );
  const mutations = [
    (output: NonNullable<typeof item.postmatchReview>) => {
      output.team_reviews![0].outcome = 'won';
    },
    (output: NonNullable<typeof item.postmatchReview>) => {
      output.team_reviews![1].team = 'A';
    },
    (output: NonNullable<typeof item.postmatchReview>) => {
      output.team_reviews![1].team = 'unknown';
    },
    (output: NonNullable<typeof item.postmatchReview>) => {
      output.team_reviews![0].strengths[0].evidence_ids = ['factor:rating'];
    },
    (output: NonNullable<typeof item.postmatchReview>) => {
      output.team_reviews![0].strengths[0].evidence_ids = ['fact:map:99'];
    },
    (output: NonNullable<typeof item.postmatchReview>) => {
      output.team_reviews![0].strengths[0].claim = 'x'.repeat(181);
    },
    (output: NonNullable<typeof item.postmatchReview>) => {
      output.team_reviews![0].possible_explanation = {
        claim: '可能原因',
        evidence_ids: ['fact:invented'],
      };
    },
  ];
  for (const mutate of mutations) {
    const output = structuredClone(item.postmatchReview!);
    mutate(output);
    assert.throws(() => validateR2Analysis(output, item.postmatchEvidence!));
  }
});

test('legacy output remains readable but is not invented into new per-team facts', () => {
  const item = reviewFixture();
  delete item.postmatchReview!.team_reviews;
  assert.deepEqual(verifiedTeamReviews(item), []);
  const legacy = structuredClone(item.postmatchEvidence!);
  delete legacy.reviewFocus;
  delete legacy.teamOutcomes;
  assert.doesNotThrow(() => validateR2Analysis(item.postmatchReview!, legacy));
  assert.throws(() =>
    validateR2Analysis(item.postmatchReview!, item.postmatchEvidence!),
  );
});

test('insufficient evidence permits empty team claims, not fake causal content', () => {
  const item = reviewFixture();
  item.postmatchReview!.team_reviews!.forEach((team) => {
    team.strengths = [];
    team.weaknesses = [];
  });
  assert.doesNotThrow(() =>
    validateR2Analysis(item.postmatchReview!, item.postmatchEvidence!),
  );
  assert.equal(verifiedTeamReviews(item).length, 2);
  assert.ok(
    item.postmatchEvidence!.missingEvidence.includes(
      'prematch_player_map_baseline',
    ),
  );
  assert.deepEqual(
    item.postmatchEvidence!.teamOutcomes!.map((team) => team.outcome),
    ['lost', 'won'],
  );
});
