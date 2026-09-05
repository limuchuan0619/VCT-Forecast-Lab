import type { PublicOverview } from './vct-types';

export const fallbackOverview: PublicOverview = {
  prediction: {
    id: '5c150c21-a03a-4817-af9a-a45b7871549e', source: 'system_auto', modelVersion: 'v1.0.0',
    lockedAt: '2026-08-30T18:07:51.688Z', scheduledAt: '2026-08-30T20:00:00.000Z', event: 'VCT 2026: Americas Stage 2',
    region: 'AMERICAS', patch: 'cohort:2026-stage-2', seriesFormat: 'bo3', teamA: 'LOUD', teamB: 'MIBR',
    teamAProbability: 0.433992, predictedScore: '0-2', status: 'resolved', actualWinner: 'LOUD', actualScore: '2-0',
    resolvedAt: '2026-08-30T20:10:00.000Z', dataCutoffAt: '2026-08-30T18:07:51.688Z',
    factors: [
      { key: 'team_rating', rank: 1, label: 'Team Rating', detail: '有效分差 -79.4', probabilityPoints: -16.742278, absoluteShare: 0.486172 },
      { key: 'map_pool', rank: 2, label: '地图池', detail: '固定 BP 顺序', probabilityPoints: 9.721157, absoluteShare: 0.282289 },
      { key: 'player_form', rank: 3, label: '选手状态', detail: 'A/B -0.443 / -0.019', probabilityPoints: -3.215726, absoluteShare: 0.09338 },
      { key: 'recent_form', rank: 4, label: '近期状态', detail: '13 / 16 场衰减样本', probabilityPoints: 2.377378, absoluteShare: 0.069036 },
      { key: 'roster_continuity', rank: 5, label: '阵容连续性', detail: 'A/B 0.60 / 0.40', probabilityPoints: 1.419203, absoluteShare: 0.041212 },
      { key: 'series_adaptability', rank: 6, label: 'BO3 适应', detail: 'A/B 0.400 / 0.508', probabilityPoints: -0.560859, absoluteShare: 0.016287 },
      { key: 'patch_fit', rank: 7, label: 'Patch 适应', detail: 'A/B 0.412 / 0.335', probabilityPoints: 0.40033, absoluteShare: 0.011625 },
    ],
    maps: [
      { map: '日落之城', teamAProbability: 0.479874, teamBProbability: 0.520126, samples: [14, 17] },
      { map: '霓虹町', teamAProbability: 0.423229, teamBProbability: 0.576771, samples: [15, 24] },
      { map: '微风岛屿', teamAProbability: 0.464663, teamBProbability: 0.535337, samples: [10, 12] },
    ],
    scoreDistribution: { '0-2': 0.299994, '1-2': 0.266014, '2-0': 0.203096, '2-1': 0.230896 },
    evidence: { sourceUrl: 'https://www.vlr.gg/734312/loud-vs-mibr-vct-2026-americas-stage-2-lr2', sourceLabel: 'VLR 社区赛事页', patchProvenance: '赛事阶段推断', qualityGate: 'ready', sourceSnapshotAt: '2026-08-30T18:08:06.160Z', temporalNote: 'source_snapshot_timestamp_after_lock_using_lock_as_cutoff' },
  },
  data: { matches: 1512, teams: 68, predictions: 15, regions: 4, cutoffAt: '2026-08-30T18:08:06.160Z' },
  ai: { configured: false, status: 'waiting_for_key', modelId: 'deepseek-v4-pro', analysis: null },
  governance: { champion: 'v1.0.0', globalWeightsFrozen: true, observedSamples: 15, minimumSampleGate: 100, promotionEnabled: false },
  automation: {
    status: 'waiting', lastRunStatus: null, lastRunStartedAt: null, lastRunCompletedAt: null, nextExpectedAt: null,
    dataUpdatedAt: null, lastAiCompletedAt: null, intervalSeconds: 7200, horizonHours: 48,
    pendingResults: 0, pendingReviews: 0, lastCounters: {},
  },
  learning: {
    mode: 'prospective_gold', startedAt: null, snapshots: 0, fixtures: 0, ready: 0,
    blocked: 0, labeled: 0, pending: 0, trainingEligible: 0, trainingGate: 100,
  },
};
