import type { FactorContribution, PredictionRecord } from './vct-types.ts';
import { localizeValorantText } from './valorant-terms.ts';

export const modelNames = {
  champion: '系统预测',
  c1: '试验预测',
  deepseek: 'AI 参考',
} as const;
export type ComparisonModel = keyof typeof modelNames;
const validProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
const instant = (value?: string | null) => (value ? Date.parse(value) : NaN);

export function chinaDay(value: string | number | Date): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10)
    : '';
}
export function tomorrowChinaDay(now = Date.now()): string {
  return chinaDay(now + 86400000);
}
export function adjacentDay(day: string, offset: number): string {
  return chinaDay(Date.parse(`${day}T00:00:00+08:00`) + offset * 86400000);
}
export function validDay(day?: string): boolean {
  return Boolean(
    day &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    chinaDay(`${day}T00:00:00+08:00`) === day,
  );
}
export function matchesOnDay(
  records: PredictionRecord[],
  day: string,
): PredictionRecord[] {
  return records
    .filter(
      (r) => r.source.startsWith('system') && chinaDay(r.scheduledAt) === day,
    )
    .sort((a, b) => instant(a.scheduledAt) - instant(b.scheduledAt));
}
export function resultSentence(record: PredictionRecord): string {
  if (
    record.status !== 'resolved' ||
    !record.actualWinner ||
    !record.actualScore
  )
    return '等待比赛结果确认';
  const scores = record.actualScore.split(/[-:：]/);
  const score =
    record.actualWinner === record.teamB ? [...scores].reverse() : scores;
  const loser =
    record.actualWinner === record.teamA ? record.teamB : record.teamA;
  return `${record.actualWinner} ${score.join(':')} 击败 ${loser}`;
}
export function reviewSummary(record: PredictionRecord): string {
  if (record.status !== 'resolved') return '比赛结果确认后将自动复盘。';
  const winnerCorrect =
    record.scorecard?.winnerCorrect ??
    (record.teamAProbability >= 0.5 ? record.teamA : record.teamB) ===
      record.actualWinner;
  const exact =
    record.scorecard?.exactScoreCorrect ??
    record.predictedScore === record.actualScore;
  return `${resultSentence(record)}。${winnerCorrect ? '胜者判断正确' : '胜者判断未命中'}；${exact ? '比分也命中' : `原预测比分 ${record.predictedScore.replace('-', ':')}，比分未命中`}。`;
}
export function plainText(text: string, record?: PredictionRecord): string {
  const replacements: Array<[RegExp, string]> = [
    [/(\d+(?:\.\d+)?)\s*ADR\b/g, '每回合伤害 $1'],
    [/\bADR\b/g, '每回合伤害'],
    [/\bACS\b/g, '平均战斗评分'],
    [/\bteam_a\b/gi, record?.teamA ?? '第一支队伍'],
    [/\bteam_b\b/gi, record?.teamB ?? '第二支队伍'],
    [/MODEL SIGNAL/g, '赛前判断依据'],
    [/HYPOTHESIS/g, '尚待验证的推测'],
    [/\bFACT\b/g, '已确认情况'],
    [/\bShapley\b/gi, '各因素对胜率的贡献'],
    [/\bRating\b/g, '实力评分'],
    [/\bPatch\b/gi, '版本或赛事环境'],
    [/\brating_points\b/g, '实力评分'],
    [/\brating_offset\b/g, '地图评分差'],
    [/\bnormalized\b/g, '相对评分，非胜率'],
    [/\bA (?=[+-]?\d)/g, `${record?.teamA ?? '第一支队伍'} `],
    [/\bB (?=[+-]?\d)/g, `${record?.teamB ?? '第二支队伍'} `],
    [/\bevent_cohort\b/g, '赛事分组（不是真实游戏版本）'],
    [/惊讶度|意外度/g, '结果与预测的差异'],
    [/方向反转/g, '胜者判断未命中'],
    [/影子分析/g, '辅助分析'],
    [/质量门/g, '数据检查'],
    [/快照/g, '当时保存的数据'],
    [/\bmoderate\b/g, '中等'],
  ];
  return replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    localizeValorantText(text),
  );
}
export function factorName(key: string, fallback: string): string {
  return (
    (
      {
        rating: '整体实力',
        team_rating: '整体实力',
        recent_form: '近期表现',
        opponent_quality: '此前对手的强度',
        map_pool: '地图表现',
        map_strength: '地图表现',
        roster: '阵容稳定程度',
        roster_continuity: '阵容稳定程度',
        player_form: '选手近期表现',
        patch_fit: '赛事环境适应情况',
        international_experience: '国际赛经验',
        international: '国际赛经验',
        series_adaptability: '赛制适应情况',
        bo_experience: '赛制经验',
        tactical_matchup: '战术对位',
      } as Record<string, string>
    )[key] ?? plainText(fallback)
  );
}

export function factorDescription(
  factor: FactorContribution,
  record: PredictionRecord,
): string {
  return (
    (
      {
        team_rating: '根据赛前积累的比赛成绩评估双方整体实力。',
        map_pool: '结合赛前保存的各地图表现，不代表实际选图已经确定。',
        patch_fit: '使用赛事分组等可用信息，不等同于真实游戏版本。',
        roster_continuity:
          '衡量此前观察到的阵容稳定程度，不代表本场已公布的首发。',
        recent_form: '评估近期比赛表现，而不只统计胜负。',
        player_form: '综合赛前能够获得的选手表现。',
        series_adaptability: '评估双方对本场赛制的适应情况。',
        international_experience: '考虑此前积累的国际赛经验。',
        tactical_matchup: '仅使用已经保存的对位判断；没有证据时不额外推测。',
      } as Record<string, string>
    )[factor.key] ?? plainText(factor.detail, record)
  );
}

export function replayFeatureName(key: string): string {
  return (
    (
      {
        team_rating_diff: '整体实力差值',
        rating_diff: '整体实力差值',
        recent_form_diff: '近期表现差值',
        map_strength_diff: '地图表现差值',
        roster_continuity_diff: '阵容稳定程度差值',
        player_form_diff: '选手表现差值',
        acs_diff: '选手平均战斗评分差值',
        adr_diff: '选手每回合伤害差值',
        kast_diff: '选手有效参与回合比例差值',
        player_rating_diff: '选手综合评分差值',
        fk_fd_diff: '首杀与首死表现差值',
      } as Record<string, string>
    )[key] ?? '其他赛前指标'
  );
}

export function modelProbabilities(
  r: PredictionRecord,
): Record<ComparisonModel, number | null> {
  const start = instant(r.scheduledAt),
    locked = instant(r.lockedAt);
  const champion =
    r.source === 'system_auto' &&
    locked < start &&
    instant(r.dataCutoffAt) <= locked &&
    validProbability(r.teamAProbability)
      ? r.teamAProbability
      : null;
  const c = r.challenger;
  const c1 =
    champion !== null &&
    c?.eligible &&
    c.recordKind === 'real_prospective' &&
    c.championPredictionId === r.id &&
    c.challengerModelId === 'logistic_c1_v1.4b_20260903' &&
    c.datasetVersion === 'v1.4b-c1-20260903' &&
    instant(c.frozenAt) === locked &&
    instant(c.scheduledAt) === start &&
    c.championModelVersion === r.modelVersion &&
    Math.abs(c.championProbability - champion) < 1e-9 &&
    c.featureSnapshotHash &&
    c.artifactHash &&
    validProbability(c.challengerProbability)
      ? c.challengerProbability
      : null;
  const ai = r.prematchAnalysis;
  const deepseek =
    champion !== null &&
    r.prematchAiModelId &&
    ai?.stage === 'prematch' &&
    ai.direct_promotion_allowed === false &&
    validProbability(ai.ai_probability_team_a) &&
    instant(r.prematchAiCreatedAt) >= locked &&
    instant(r.prematchAiCreatedAt) < start
      ? ai.ai_probability_team_a
      : null;
  return { champion, c1, deepseek };
}

export type ModelMetrics = {
  matches: number;
  brier: number;
  logLoss: number;
  accuracy: number;
  ece: number;
  highConfidenceCount: number;
  highConfidenceAccuracy: number | null;
  bins: Array<{
    count: number;
    probability: number | null;
    winRate: number | null;
  }>;
};
export function eligibleComparisonRecords(
  records: PredictionRecord[],
  models: ComparisonModel[],
): PredictionRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = r.challenger?.fixtureId ?? r.id;
    if (
      seen.has(key) ||
      r.status !== 'resolved' ||
      !r.scorecard ||
      !r.resultEvidence ||
      ![r.teamA, r.teamB].includes(r.actualWinner ?? '') ||
      r.scorecard.actualWinner !== r.actualWinner ||
      r.resultEvidence.series.actualWinner !== r.actualWinner ||
      r.scorecard.actualScore !== r.actualScore ||
      r.resultEvidence.series.actualScore !== r.actualScore
    )
      return false;
    if (
      models.includes('c1') &&
      (r.challenger?.status !== 'resolved' ||
        r.challenger.actualWinner !== r.actualWinner)
    )
      return false;
    const p = modelProbabilities(r);
    if (!models.every((model) => p[model] !== null)) return false;
    seen.add(key);
    return true;
  });
}

export function comparisonCoverage(
  records: PredictionRecord[],
  models: ComparisonModel[],
) {
  const resolved = records.filter((r) => r.status === 'resolved');
  const eligible = eligibleComparisonRecords(records, models);
  return {
    total: records.length,
    pending: records.length - resolved.length,
    resolved: resolved.length,
    eligible: eligible.length,
    missing: Object.fromEntries(
      models.map((model) => [
        model,
        resolved.filter((r) => modelProbabilities(r)[model] === null).length,
      ]),
    ) as Record<ComparisonModel, number>,
    excluded: resolved.length - eligible.length,
  };
}

export function largestDisagreements(
  records: PredictionRecord[],
  models: ComparisonModel[],
  limit = 3,
) {
  return eligibleComparisonRecords(records, models)
    .map((record) => {
      const p = modelProbabilities(record);
      const probabilities = models.map((model) => p[model]!);
      return {
        record,
        gap: Math.max(...probabilities) - Math.min(...probabilities),
      };
    })
    .sort((a, b) => b.gap - a.gap || a.record.id.localeCompare(b.record.id))
    .slice(0, limit);
}

export function evaluateModels(
  records: PredictionRecord[],
  models: ComparisonModel[],
): {
  matches: number;
  metrics: Partial<Record<ComparisonModel, ModelMetrics>>;
} {
  const samples = eligibleComparisonRecords(records, models);
  const metrics: Partial<Record<ComparisonModel, ModelMetrics>> = {};
  if (!samples.length) return { matches: 0, metrics };
  for (const model of models) {
    let brier = 0,
      logLoss = 0,
      correct = 0,
      high = 0,
      highCorrect = 0;
    const bins = Array.from({ length: 10 }, () => ({ count: 0, p: 0, y: 0 }));
    for (const r of samples) {
      const p = modelProbabilities(r)[model]!,
        y = Number(r.actualWinner === r.teamA),
        hit = Number(p >= 0.5 === Boolean(y));
      brier += (p - y) ** 2;
      logLoss -= Math.log(Math.max(1e-15, y ? p : 1 - p));
      correct += hit;
      if (Math.max(p, 1 - p) >= 0.7) {
        high++;
        highCorrect += hit;
      }
      const bin = bins[Math.min(9, Math.floor(p * 10))];
      bin.count++;
      bin.p += p;
      bin.y += y;
    }
    metrics[model] = {
      matches: samples.length,
      brier: brier / samples.length,
      logLoss: logLoss / samples.length,
      accuracy: correct / samples.length,
      ece:
        bins.reduce((sum, bin) => sum + Math.abs(bin.p - bin.y), 0) /
        samples.length,
      highConfidenceCount: high,
      highConfidenceAccuracy: high ? highCorrect / high : null,
      bins: bins.map((bin) => ({
        count: bin.count,
        probability: bin.count ? bin.p / bin.count : null,
        winRate: bin.count ? bin.y / bin.count : null,
      })),
    };
  }
  return { matches: samples.length, metrics };
}
