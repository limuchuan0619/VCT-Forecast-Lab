import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editorialEvidence,
  validateEditorialPlan,
} from '../lib/review-editorial.ts';
import { reviewFixture } from './fixtures/match-review.ts';
import type { ReaderInsights } from '../lib/reader-analysis.ts';

test('editorial arithmetic is descriptive, complete-row only and never turns missing kills into zero', () => {
  const insights: ReaderInsights = {
    maps: [
      {
        order: 1,
        map: '莲华古城',
        score: '13:8',
        winner: 'A',
        openingA: null,
        openingB: null,
        reference: 'fact:map:1',
        players: Array.from({ length: 5 }, (_, i) => ({
          id: `p${i}`,
          name: `P${i}`,
          team: 'A',
          agent: 'skye',
          kills: i + 1,
          deaths: 2,
          assists: 0,
          adr: null,
          firstKills: null,
          firstDeaths: null,
        })),
      },
    ],
    positions: [],
    identityStatus: 'verified',
    limits: [],
  };
  const before = JSON.stringify(insights);
  const a = editorialEvidence(insights, ['A', 'B'])[0].teams[0];
  assert.equal(a.kills, 15);
  assert.equal(a.firstKills, null);
  assert.equal(a.leaders[0].shareOfTeamKills, 5 / 15);
  assert.equal(editorialEvidence(insights, ['A', 'B'])[0].teams[1].kills, null);
  assert.equal(JSON.stringify(insights), before);
  insights.maps[0].players[0].kills = null;
  const missing = editorialEvidence(insights, ['A', 'B'])[0].teams[0];
  assert.equal(missing.kills, null);
  assert.deepEqual(missing.leaders, []);
});
test('evidence plan rejects unknown, non-fact, cross-map and duplicate-map references', () => {
  const packet = reviewFixture().postmatchEvidence!;
  const plan = {
    thesis: '只能解释已确认的表现差异。',
    findings: [],
    maps: packet.readerInsights!.maps.map((m) => ({
      order: m.order,
      angle: '本图没有足够选手数据。',
      limit: '不能判断战术原因。',
      evidence_ids: [m.reference],
    })),
  };
  assert.equal(
    validateEditorialPlan(
      plan,
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
    plan,
  );
  for (const refs of [
    ['fact:map:99'],
    ['prediction:locked_snapshot'],
    ['fact:map:2'],
  ]) {
    const invalid = structuredClone(plan);
    invalid.maps[0].evidence_ids = refs;
    assert.throws(() =>
      validateEditorialPlan(
        invalid,
        packet.readerInsights!,
        packet.evidenceReferences,
      ),
    );
  }
  const duplicate = structuredClone(plan);
  duplicate.maps[1] = duplicate.maps[0];
  assert.throws(() =>
    validateEditorialPlan(
      duplicate,
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
  );
});
