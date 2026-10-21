import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { reviewFixture } from './fixtures/match-review.ts';
import { prematchReasons, readerInsights } from '../lib/reader-analysis.ts';
import { validatedPrematchContext } from '../lib/prematch-context.ts';
import {
  reviewObservations,
  assembleEvidenceReview,
  validateEvidenceArticle,
  EVIDENCE_REVIEW_PROMPT,
  EVIDENCE_REVIEW_SCHEMA,
} from '../lib/review-evidence.ts';
import type { EvidenceSelection } from '../lib/review-evidence.ts';
import {
  buildAnalysisPacket,
  validateR2Analysis,
  validatePrematchAnalysis,
} from '../lib/ai-reliability.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith('.') &&
      context.parentURL?.startsWith('file:') &&
      !/\.[a-z]+$/i.test(specifier)
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate))
        return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { analyzePostmatchR2 } = await import('../lib/deepseek.ts');
function fixture() {
  const r = reviewFixture();
  r.teamA = 'LOUD';
  r.teamB = 'Team Vitality';
  r.actualWinner = r.teamB;
  r.resultEvidence!.source.sourceId = 'vlr';
  r.resultEvidence!.series.actualWinner = r.teamB;
  r.resultEvidence!.maps.forEach((m, i) => {
    m.winner = i === 0 ? r.teamA : r.teamB;
  });
  r.resultEvidence!.playerStats = r.resultEvidence!.maps.flatMap((map) =>
    ['vlr_team_6961', 'vlr_team_2059'].flatMap((teamId, team) =>
      Array.from({ length: 5 }, (_, i) => ({
        mapOrder: map.order,
        teamId,
        playerId: `p${team}-${i}`,
        player: `test${team}-${i}`,
        agent: ['neon', 'omen', 'fade', 'viper', 'chamber'][i],
        kills: 12 + i + team,
        deaths: 8 + i,
        assists: 3,
        adr: 100 + i * 10 + team * 5,
        firstKills: 1,
        firstDeaths: 1,
      })),
    ),
  );
  r.postmatchEvidence = buildAnalysisPacket(r);
  return r;
}
function selection(r = fixture()): EvidenceSelection {
  const observations = reviewObservations(
    r.postmatchEvidence!.readerInsights!,
    [r.teamA, r.teamB],
  );
  return {
    summary: '双方各有竞争力，地图间的表现差异比总比分更值得关注。',
    summary_observations: ['series:map-differences'],
    reasons: [],
    maps: r.resultEvidence!.maps.map((m) => ({
      order: m.order,
      observation_id: `map:${m.order}:leaders`,
      interpretation:
        '同图两边的主要输出点并不相同，不能只凭整场胜负概括每名选手的表现。',
    })),
    matchups: [],
  };
}

test('legacy Chinese factor labels bind through a single exact frozen evidence ID, never arbitrary labels', () => {
  const r = fixture();
  r.factors = [
    {
      key: 'recent_form',
      label: '近期状态',
      rank: 1,
      detail: 'saved',
      probabilityPoints: 5,
      absoluteShare: 1,
    },
  ];
  r.prematchAiCreatedAt = '2026-09-01T01:00:00Z';
  r.prematchAnalysis = {
    key_factors: [
      {
        factor: '近期状态',
        direction: 'team_a',
        importance: 1,
        claim: '近期表现的赛前评估偏向 LOUD。',
        evidence_ids: ['factor:recent_form'],
      },
    ],
  } as any;
  const before = JSON.stringify(r);
  assert.equal(prematchReasons(r).reasons[0].source, 'ai');
  assert.match(prematchReasons(r).source, /AI 解释/);
  r.prematchAnalysis!.key_factors[0].evidence_ids = ['factor:invented'];
  assert.equal(prematchReasons(r).reasons[0].source, 'data');
  r.prematchAnalysis!.key_factors[0].evidence_ids = ['factor:recent_form'];
  assert.equal(JSON.stringify(r), before);
});
test('map display weighs sample availability, warns at five/four/unknown and does not invent a probability', () => {
  const r = fixture();
  r.maps = [
    {
      map: '幽邃地窟',
      teamAProbability: 0.7,
      teamBProbability: 0.3,
      samples: [5, 11],
    },
    {
      map: '莲华古城',
      teamAProbability: 0.51,
      teamBProbability: 0.49,
      samples: [20, 20],
    },
    {
      map: '天枢云阙',
      teamAProbability: 0.55,
      teamBProbability: 0.45,
      samples: [10, 4],
    },
  ];
  const before = JSON.stringify(r);
  const reading = prematchReasons(r);
  assert.match(reading.maps[0], /莲华古城.*五五开/);
  assert.match(reading.maps[1], /5 和 11.*样本偏少/);
  assert.match(reading.maps[2], /10 和 4.*样本偏少/);
  assert.equal(JSON.stringify(r), before);
  delete r.maps[0].samples;
  assert.ok(
    prematchReasons(r).maps.some((x) => x.includes('没有保存参考场次')),
  );
});
test('unverified historical player aggregation cannot be presented as current-five form', () => {
  const r = fixture();
  r.factors = [
    {
      key: 'player_form',
      rank: 1,
      label: '选手状态',
      detail: '11 historical players',
      probabilityPoints: 10,
      absoluteShare: 1,
    },
  ];
  assert.equal(prematchReasons(r).reasons.length, 0);
  assert.match(prematchReasons(r).limit, /五人/);
});
test('auxiliary prematch facts require exclusive played/known cutoffs and exact team/source binding', () => {
  const r = fixture(),
    context = {
      schemaVersion: 'prematch-reader-evidence-v1',
      cutoffAt: r.lockedAt,
      recentMatches: [
        {
          reference: 'history:team_a:vlr_match_123',
          matchId: 'vlr_match_123',
          team: r.teamA,
          opponent: 'Historical opponent',
          teamScore: 2,
          opponentScore: 1,
          playedAt: '2026-08-30T00:00:00Z',
          knownAt: '2026-08-31T00:00:00Z',
          sourceUrl: 'https://www.vlr.gg/123/example',
        },
      ],
      limits: [],
    };
  assert.ok(validatedPrematchContext(context, r));
  for (const key of ['playedAt', 'knownAt'] as const) {
    const copy = structuredClone(context);
    copy.recentMatches[0][key] = r.lockedAt;
    assert.equal(validatedPrematchContext(copy, r), null);
  }
  const wrong = structuredClone(context);
  wrong.recentMatches[0].sourceUrl = 'https://www.vlr.gg/456/wrong';
  assert.equal(validatedPrematchContext(wrong, r), null);
  assert.equal(
    validatedPrematchContext({ ...context, cutoffAt: r.scheduledAt }, r),
    null,
  );
});
test('new prematch output binds canonical factors and model map probabilities to its stored packet; old contracts remain readable', () => {
  const input = {
    factor_contributions: [
      { key: 'recent_form', evidence_id: 'factor:recent_form' },
    ],
    map_probabilities: [
      { map: '莲华古城', evidence_id: 'map:莲华古城', teamAProbability: 0.55 },
    ],
  };
  const output = {
    stage: 'prematch',
    summary: '接近的对局。',
    ai_probability_team_a: 0.54,
    key_factors: [
      {
        factor: 'recent_form',
        direction: 'team_a',
        claim: '赛前近期表现评估稍偏向主队。',
        evidence_ids: ['factor:recent_form'],
      },
    ],
    map_analysis: [
      {
        map: '莲华古城',
        team_a_probability: 0.55,
        evidence_ids: ['map:莲华古城'],
      },
    ],
    risk_flags: [],
    upset_conditions: [],
    direct_promotion_allowed: false,
  };
  assert.doesNotThrow(() => validatePrematchAnalysis(output, input));
  const wrongKey = structuredClone(output);
  wrongKey.key_factors[0].factor = '近期表现';
  assert.throws(
    () => validatePrematchAnalysis(wrongKey, input),
    /factor_binding/,
  );
  assert.doesNotThrow(() => validatePrematchAnalysis(wrongKey));
  const wrongMap = structuredClone(output);
  wrongMap.map_analysis[0].team_a_probability = 0.8;
  assert.throws(() => validatePrematchAnalysis(wrongMap, input), /map_binding/);
  const wrongRef = structuredClone(output);
  wrongRef.key_factors[0].evidence_ids.push('history:unknown');
  assert.throws(
    () => validatePrematchAnalysis(wrongRef, input),
    /factor_binding/,
  );
});
test('facts are assembled from original rows; wrong numeric/cross-map observations and process claims are rejected', () => {
  const r = fixture(),
    ins = r.postmatchEvidence!.readerInsights!,
    obs = reviewObservations(ins, [r.teamA, r.teamB]);
  const s = selection(r),
    article = assembleEvidenceReview(
      s,
      obs,
      ins,
      r.postmatchEvidence!.evidenceReferences,
    );
  assert.match(article.maps[0].fact, /最高击杀/);
  assert.doesNotMatch(article.maps[0].fact, /全队.*伤害/);
  const forged = structuredClone(article);
  forged.maps[0].fact = forged.maps[0].fact.replace('杀', '1743杀');
  assert.throws(
    () =>
      validateEvidenceArticle(
        { reader_evidence_selection: s, reader_review: forged },
        ins,
        [r.teamA, r.teamB],
        r.postmatchEvidence!.evidenceReferences,
      ),
    /article_changed/,
  );
  for (const interpretation of [
    '他每回合伤害1743。',
    '拿到首杀后更难被反制。',
    '靠残局赢下关键回合。',
  ]) {
    const invalid = structuredClone(s);
    invalid.maps[0].interpretation = interpretation;
    assert.throws(
      () =>
        assembleEvidenceReview(
          invalid,
          obs,
          ins,
          r.postmatchEvidence!.evidenceReferences,
        ),
      /unproven/,
    );
  }
  const wrong = structuredClone(s);
  wrong.maps[0].observation_id = 'map:2:leaders';
  assert.throws(
    () =>
      assembleEvidenceReview(
        wrong,
        obs,
        ins,
        r.postmatchEvidence!.evidenceReferences,
      ),
    /binding/,
  );
  const duplicate = structuredClone(s);
  duplicate.reasons = [
    {
      observation_id: duplicate.maps[0].observation_id,
      title: '重复',
      interpretation: '同样观察。',
    },
  ];
  assert.throws(
    () =>
      assembleEvidenceReview(
        duplicate,
        obs,
        ins,
        r.postmatchEvidence!.evidenceReferences,
      ),
    /binding/,
  );
});
test('missing player metrics stay unavailable instead of becoming fabricated leaders or zero', () => {
  const r = fixture();
  r.resultEvidence!.playerStats![0].kills = null;
  const obs = reviewObservations(readerInsights(r), [r.teamA, r.teamB]);
  assert.ok(!obs.some((o) => o.id === 'map:1:leaders'));
});
test('new review uses one bounded request; one validation repair is allowed, trace excludes credentials, probability immutable', async () => {
  const original = globalThis.fetch;
  const r = fixture(),
    before = JSON.stringify(r),
    bodies: any[] = [],
    traces: any[] = [];
  const good = selection(r);
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    const output = structuredClone(good);
    if (bodies.length === 1) output.maps[0].interpretation = '他造成1743伤害。';
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify(output),
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const response = await analyzePostmatchR2(
      'isolated-secret-key',
      'isolated-provider',
      r,
      r.postmatchEvidence!,
      {
        promptVersion: EVIDENCE_REVIEW_PROMPT,
        schemaVersion: EVIDENCE_REVIEW_SCHEMA,
        onDiagnostic: async (record) => {
          traces.push(record);
        },
      },
    );
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].reasoning.effort, 'none');
    assert.equal(bodies[0].max_output_tokens, 2800);
    assert.equal(
      JSON.parse(bodies[1].input).validation_error,
      'schema_evidence_unproven_interpretation',
    );
    assert.ok(traces.some((t) => t.phase === 'article_repair'));
    assert.doesNotMatch(JSON.stringify(traces), /isolated-secret-key/);
    validateR2Analysis(response.output, r.postmatchEvidence!);
    assert.equal(
      response.output.reader_generation_mode,
      'evidence_selected_commentary',
    );
    assert.equal(JSON.stringify(r), before);
  } finally {
    globalThis.fetch = original;
  }
});
test('permanent bad output stops after two calls and transport failure is left to bounded job retry', async () => {
  const original = globalThis.fetch;
  let count = 0;
  const r = fixture();
  globalThis.fetch = (async () => {
    count++;
    return new Response(
      JSON.stringify({ output_text: JSON.stringify({ bad: true }) }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        analyzePostmatchR2('isolated', 'mock', r, r.postmatchEvidence!, {
          promptVersion: EVIDENCE_REVIEW_PROMPT,
          schemaVersion: EVIDENCE_REVIEW_SCHEMA,
        }),
      /schema_evidence_selection/,
    );
    assert.equal(count, 2);
    count = 0;
    globalThis.fetch = (async () => {
      count++;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as typeof fetch;
    await assert.rejects(
      () =>
        analyzePostmatchR2('isolated', 'mock', r, r.postmatchEvidence!, {
          promptVersion: EVIDENCE_REVIEW_PROMPT,
          schemaVersion: EVIDENCE_REVIEW_SCHEMA,
        }),
      /timeout/,
    );
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = original;
  }
});
