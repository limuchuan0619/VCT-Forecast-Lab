import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  readerInsights,
  prematchReasons,
  predictionHeadline,
  sourceTeamId,
  validateReaderReview,
  normalizeReaderReview,
} from '../lib/reader-analysis.ts';
import { buildAnalysisPacket } from '../lib/ai-reliability.ts';
import { verifiedReaderReview } from '../lib/match-review.ts';
import { reviewFixture } from './fixtures/match-review.ts';

function sample() {
  const r = reviewFixture();
  r.teamA = 'Team Vitality';
  r.teamB = '100 Thieves';
  r.actualWinner = r.teamB;
  r.resultEvidence!.source.sourceId = 'vlr';
  r.resultEvidence!.series.actualWinner = r.teamB;
  r.resultEvidence!.maps.forEach((m, i) => {
    m.winner = i === 0 ? r.teamA : r.teamB;
  });
  r.resultEvidence!.playerStats = r.resultEvidence!.maps.flatMap((map) =>
    ['vlr_team_2059', 'vlr_team_120'].flatMap((teamId, team) =>
      Array.from({ length: 5 }, (_, i) => ({
        mapOrder: map.order,
        teamId,
        playerId: `p${team}-${i}`,
        player: `player${team}-${i}`,
        agent: ['neon', 'fade', 'chamber', 'omen', 'viper'][i],
        kills: 12 + i,
        deaths: 14 - i,
        assists: 3,
        adr: 150,
        firstKills: i === 0 ? (team === 0 ? 3 : 1) : 1,
        firstDeaths: i === 0 ? (team === 0 ? 1 : 3) : 1,
      })),
    ),
  );
  return r;
}

test('provider nested fact wrappers normalize losslessly, but conflicts and invented references still fail', () => {
  const r = reviewFixture(),
    packet = r.postmatchEvidence!,
    flat = r.postmatchReview!.reader_review!;
  const wrapped = structuredClone(flat);
  wrapped.maps = flat.maps.map(({ order, map, ...claim }) => ({
    order,
    map,
    fact: claim,
  })) as unknown as typeof flat.maps;
  const before = JSON.stringify(wrapped);
  assert.throws(() =>
    validateReaderReview(
      wrapped,
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
  );
  const fixed = normalizeReaderReview(wrapped);
  assert.deepEqual(fixed, flat);
  assert.doesNotThrow(() =>
    validateReaderReview(
      fixed,
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
  );
  const conflict = structuredClone(wrapped) as any;
  conflict.maps[0].fact.order = 99;
  assert.throws(() =>
    validateReaderReview(
      normalizeReaderReview(conflict),
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
  );
  const invented = structuredClone(wrapped) as any;
  invented.maps[0].fact.evidence_ids = ['fact:map:99'];
  assert.throws(() =>
    validateReaderReview(
      normalizeReaderReview(invented),
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
  );
  assert.equal(JSON.stringify(wrapped), before, 'input stays unchanged');
  const impossibleCount = structuredClone(flat);
  impossibleCount.maps[0].fact = '全队首死65比77，赢得比赛。';
  assert.throws(
    () =>
      validateReaderReview(
        impossibleCount,
        packet.readerInsights!,
        packet.evidenceReferences,
      ),
    /impossible_opening_count/,
  );
  const inventedTimeline = structuredClone(flat);
  inventedTimeline.maps[0].interpretation = '这是中后期控图带来的胜利。';
  assert.throws(
    () =>
      validateReaderReview(
        inventedTimeline,
        packet.readerInsights!,
        packet.evidenceReferences,
      ),
    /unsupported_timeline/,
  );
});
test('reader hides arbitrary scores and unknown factors without changing pre-match values', () => {
  const r = sample();
  r.factors = [
    {
      key: 'recent_form',
      label: 'x',
      rank: 1,
      detail: 'A 0.610 / B 0.228 normalized',
      probabilityPoints: 5.22,
      absoluteShare: 0.7,
    },
    {
      key: 'roster_continuity',
      label: 'x',
      rank: 2,
      detail: 'A 0.6 / B 0.8',
      probabilityPoints: -1.82,
      absoluteShare: 0.3,
    },
    {
      key: 'tactical_matchup',
      label: 'x',
      rank: 3,
      detail: 'A 0 / B 0',
      probabilityPoints: 0,
      absoluteShare: 0,
    },
  ];
  const before = JSON.stringify(r);
  const text = JSON.stringify(prematchReasons(r).reasons);
  assert.match(text, /近期表现|阵容稳定性/);
  assert.doesNotMatch(text, /0\.610|normalized|tactical_matchup|影子|版本适应/);
  assert.equal(JSON.stringify(r), before);
});
test('close probabilities are not presented as strong preferences and invalid is not fifty', () => {
  const r = sample();
  r.teamAProbability = 0.497496;
  assert.equal(predictionHeadline(r), '双方接近五五开');
  r.teamAProbability = NaN;
  assert.equal(predictionHeadline(r), '胜率暂时无法显示');
});
test('team identity uses verified stable IDs, never table order or the winning team', () => {
  assert.equal(sourceTeamId('Team Vitality'), 'vlr_team_2059');
  assert.equal(sourceTeamId('DRX'), 'vlr_team_8185');
  assert.equal(sourceTeamId('not a known team'), null);
  const r = sample(),
    before = JSON.stringify(r);
  const insights = readerInsights(r);
  assert.equal(insights.identityStatus, 'verified');
  assert.equal(insights.maps[0].players.length, 10);
  assert.equal(insights.maps[0].players[0].team, 'Team Vitality');
  assert.equal(JSON.stringify(r), before);
  r.resultEvidence!.playerStats!.reverse();
  assert.equal(
    readerInsights(r).maps[0].players.find((p) => p.id === 'p0-0')!.team,
    'Team Vitality',
  );
});
test('missing stats stay null and partial or duplicate lineups cannot create team totals', () => {
  const r = sample();
  r.resultEvidence!.playerStats![0].firstKills = null;
  assert.equal(readerInsights(r).maps[0].openingA, null);
  const d = sample();
  d.resultEvidence!.playerStats![1].playerId =
    d.resultEvidence!.playerStats![0].playerId;
  assert.deepEqual(readerInsights(d).maps[0].players, []);
  const u = sample();
  u.teamA = 'unknown';
  assert.equal(readerInsights(u).maps[0].openingA, null);
});
test('equal damage survives position comparison and no direct duel result is fabricated', () => {
  const insights = readerInsights(sample());
  assert.ok(insights.positions.length > 0);
  assert.equal(insights.positions[0].a.adr, insights.positions[0].b.adr);
  assert.match(insights.limits.join(''), /不是两人直接交火/);
  assert.ok(
    insights.positions.length > 2,
    'give the writer candidates beyond the two largest opening gaps',
  );
});

test('LOUD names are not doubled and legacy job completion never becomes a fabricated reader article', () => {
  const r = sample();
  r.teamA = 'LOUD';
  r.resultEvidence!.playerStats!.forEach((row) => {
    if (row.teamId === 'vlr_team_2059') {
      row.teamId = 'vlr_team_6961';
      row.player = 'erde LOUD';
    }
  });
  assert.equal(readerInsights(r).maps[0].players[0].name, 'erde');
  const component = readFileSync(
    new URL('../components/match-review.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    component,
    /自动文字复盘：|readerStatus|先看谁更常拿到开局先手|总击杀之外/,
  );
  assert.match(component, /详细解读尚未生成/);
});
test('impossible first-kill totals are unavailable, not a valid opening advantage', () => {
  const r = sample();
  r.resultEvidence!.playerStats!.forEach((row) => {
    row.firstKills = 100;
  });
  assert.equal(readerInsights(r).maps[0].openingA, null);
});
test('reader evidence is map-bound, position-bound, revision-bound and cannot use model signals as facts', () => {
  const r = sample(),
    packet = buildAnalysisPacket(r),
    review = reviewFixture().postmatchReview!.reader_review!;
  r.postmatchEvidence = packet;
  r.postmatchReview!.reader_review = {
    ...review,
    maps: packet.readerInsights!.maps.map((m) => ({
      order: m.order,
      map: m.map,
      fact: `${m.winner} 获胜。`,
      interpretation: '只说明本图结果。',
      evidence_ids: [m.reference],
    })),
  };
  assert.ok(verifiedReaderReview(r));
  // A later selection/presentation policy must not discard valid older prose.
  packet.readerInsights!.positions = packet.readerInsights!.positions.slice(
    0,
    2,
  );
  delete packet.readerInsights!.analysisStyle;
  packet.readerInsights!.maps[0].players[0].name += ' VIT';
  assert.ok(verifiedReaderReview(r));
  const bad = structuredClone(r.postmatchReview!.reader_review!);
  bad.maps[0].evidence_ids = ['prediction:locked_snapshot'];
  assert.throws(() =>
    validateReaderReview(
      bad,
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
  );
  bad.maps[0].evidence_ids = ['fact:map:2'];
  assert.throws(() =>
    validateReaderReview(
      bad,
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
  );
  const pair = packet.readerInsights!.positions[0];
  bad.maps[0].evidence_ids = ['fact:map:1'];
  bad.matchups = [
    {
      mapOrder: pair.mapOrder,
      agent: pair.agent,
      playerAId: 'wrong-player',
      playerBId: pair.b.id,
      fact: '已确认资料。',
      interpretation: '表现对比。',
      evidence_ids: pair.references,
    },
  ];
  assert.throws(() =>
    validateReaderReview(
      bad,
      packet.readerInsights!,
      packet.evidenceReferences,
    ),
  );
  r.resultEvidence!.playerStats![0].adr = 999;
  assert.equal(verifiedReaderReview(r), null);
});
test('late, unsupported or raw-score prematch AI prose cannot replace a frozen reason', () => {
  const r = sample();
  r.factors = [
    {
      key: 'recent_form',
      label: 'x',
      rank: 1,
      detail: 'x',
      probabilityPoints: 2,
      absoluteShare: 1,
    },
  ];
  r.prematchAiCreatedAt = r.scheduledAt;
  r.prematchAnalysis = {
    stage: 'prematch',
    ai_probability_team_a: 0.6,
    predicted_score: '2-1',
    summary: 'x',
    key_factors: [
      {
        factor: 'recent_form',
        claim: '不应出现的晚到内容',
        direction: 'team_a',
        importance: 1,
        evidence_ids: ['factor:recent_form'],
      },
    ],
    risk_flags: [],
    upset_conditions: [],
    model_disagreement: '',
    optimization_hypotheses: [],
    direct_promotion_allowed: false,
  };
  assert.doesNotMatch(JSON.stringify(prematchReasons(r).reasons), /晚到/);
  r.prematchAiCreatedAt = r.lockedAt;
  r.prematchAnalysis.key_factors[0].claim = '近期评分0.610，已经连胜。';
  assert.doesNotMatch(
    JSON.stringify(prematchReasons(r).reasons),
    /0\.610|连胜/,
  );
});
test('public detail source has no raw audit route, feature table or nested operational disclosures', () => {
  const detail = readFileSync(
    new URL('../app/predictions/[id]/page.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    detail,
    /JSON\.stringify|factor\.detail|EvidenceReferences|replayFeatureName|ProbabilityWaterfall|view === 'audit'/,
  );
});
