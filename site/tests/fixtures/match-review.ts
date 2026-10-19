import { buildAnalysisPacket } from '../../lib/ai-reliability.ts';
import { computePostmatchScorecard } from '../../lib/postmatch-scorecard.ts';
import type { PredictionRecord } from '../../lib/vct-types.ts';

// Isolated demonstration only. Never ingested into Gold or public predictions.
export function reviewFixture(format: 'bo3' | 'bo5' = 'bo3'): PredictionRecord {
  const winners =
    format === 'bo3' ? ['A', 'B', 'B'] : ['A', 'B', 'A', 'B', 'A'];
  const names = ['莲华古城', '隐世修所', '升天之境', '幽邃地窟', '天枢云阙'];
  const actualWinner = format === 'bo3' ? 'B' : 'A';
  const actualScore = format === 'bo3' ? '1-2' : '3-2';
  const record: PredictionRecord = {
    id: 'isolated-review',
    source: 'system_auto',
    modelVersion: 'v1.0.0',
    event: 'ISOLATED DEMONSTRATION — NOT A REAL MATCH',
    region: 'CN',
    seriesFormat: format,
    teamA: 'A',
    teamB: 'B',
    lockedAt: '2026-09-01T00:00:00Z',
    scheduledAt: '2026-09-02T00:00:00Z',
    dataCutoffAt: '2026-09-01T00:00:00Z',
    teamAProbability: 0.6,
    predictedScore: format === 'bo3' ? '2-1' : '3-1',
    status: 'resolved',
    actualWinner,
    actualScore,
    resolvedAt: '2026-09-02T04:00:00Z',
    factors: [],
    maps: names.map((map) => ({
      map,
      teamAProbability: 0.6,
      teamBProbability: 0.4,
      samples: [5, 5],
    })),
    scoreDistribution: {},
    evidence: {
      sourceLabel: 'ISOLATED TEST',
      qualityGate: 'ready',
      patchProvenance: 'event_cohort',
    },
    resultEvidence: {
      schemaVersion: 'v1.4c-r1-result-evidence-v1',
      source: { sourceId: 'isolated-test', capturedAt: '2026-09-02T04:00:00Z' },
      series: {
        actualWinner,
        actualScore,
        seriesFormat: format,
        scheduledAt: '2026-09-02T00:00:00Z',
      },
      maps: winners.map((winner, index) => ({
        order: index + 1,
        map: names[index],
        winner,
        teamAScore: winner === 'A' ? 13 : 8,
        teamBScore: winner === 'B' ? 13 : 8,
        missingFields: ['attack_defense'],
      })),
      playerStats: null,
      missing: {
        maps: false,
        playerStats: true,
        veto: true,
        attackDefense: true,
      },
    },
  };
  record.scorecard = computePostmatchScorecard(
    record,
    actualWinner,
    actualScore,
  );
  record.postmatchEvidence = buildAnalysisPacket(record);
  record.postmatchReview = {
    stage: 'postmatch',
    reader_review: {
      summary: '隔离样例：地图结果已确认，选手资料不足。',
      reasons: [],
      maps: record.resultEvidence!.maps.map((map) => ({
        order: map.order,
        map: map.map,
        fact: `${map.winner} 拿下本图。`,
        interpretation: '选手资料不足，无法进一步解释。',
        evidence_ids: [`fact:map:${map.order}`],
      })),
      matchups: [],
    },
    one_line_summary: '隔离样例，不是正式赛事复盘。',
    team_reviews: [
      {
        team: 'A',
        outcome: actualWinner === 'A' ? 'won' : 'lost',
        possible_explanation: null,
        strengths: [
          { claim: '在莲华古城13:8拿下首图。', evidence_ids: ['fact:map:1'] },
        ],
        weaknesses: [
          {
            claim: '隐世修所8:13失利，首图优势没能转为连胜。',
            evidence_ids: ['fact:map:2'],
          },
        ],
      },
      {
        team: 'B',
        outcome: actualWinner === 'B' ? 'won' : 'lost',
        possible_explanation: null,
        strengths: [
          {
            claim: '隐世修所13:8取胜，扳回一张地图。',
            evidence_ids: ['fact:map:2'],
          },
        ],
        weaknesses: [
          { claim: '莲华古城8:13输掉首图。', evidence_ids: ['fact:map:1'] },
        ],
      },
    ],
    what_happened: [
      {
        claim: `系列赛${actualScore}，${actualWinner}获胜。`,
        evidence_ids: ['fact:result_evidence'],
      },
    ],
    three_signals: [
      {
        signal: 'A赛前60%，不是必胜判断。',
        relation:
          actualWinner === 'A' ? 'supported_result' : 'contradicted_result',
        evidence_ids: ['prediction:locked_snapshot'],
      },
    ],
    map_reviews: [],
    player_outliers: [],
    hypotheses: [],
    missing_evidence: ['round_timeline'],
    research_queue: null,
    direct_probability_change_allowed: false,
    direct_training_allowed: false,
    direct_promotion_allowed: false,
  };
  return record;
}
