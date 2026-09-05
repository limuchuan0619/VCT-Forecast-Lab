export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function probabilityPointDelta(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)}pp`;
}

export function chinaTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间待确认';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function regionLabel(region: string): string {
  return ({ CN: '中国', EMEA: '欧洲', AMERICAS: '美洲', PACIFIC: '太平洋' } as Record<string, string>)[region] ?? region;
}

export function predictionWinner(teamA: string, teamB: string, teamAProbability: number): string {
  return teamAProbability >= 0.5 ? teamA : teamB;
}

export type LifecycleStep = {
  label: string;
  detail: string;
  state: 'complete' | 'current' | 'pending';
};

export function predictionLifecycle(record: PredictionRecord, now = Date.now()): { label: string; steps: LifecycleStep[] } {
  const resolved = record.status === 'resolved';
  const reviewComplete = Boolean(record.postmatchReview);
  const started = Date.parse(record.scheduledAt) <= now;
  if (!record.source.startsWith('system')) {
    return {
      label: '历史人工档案',
      steps: [
        { label: '赛前判断', detail: '保留原始概率', state: 'complete' },
        { label: '结果入库', detail: resolved ? '实际赛果已保存' : '等待实际赛果', state: resolved ? 'complete' : 'current' },
        { label: '历史归档', detail: '不补造系统变量', state: resolved ? 'complete' : 'pending' },
        { label: '自动复盘', detail: '旧记录无赛前系统快照', state: 'pending' },
      ],
    };
  }
  return {
    label: reviewComplete
      ? '自动复盘完成'
      : resolved
        ? '赛果已入库，等待复盘'
        : started
          ? '等待赛果同步'
          : '赛前已锁定，等待开赛',
    steps: [
      { label: '数据质检', detail: record.evidence.qualityGate, state: 'complete' },
      { label: '赛前锁定', detail: chinaTime(record.lockedAt), state: 'complete' },
      {
        label: '结果同步',
        detail: resolved ? `${record.actualWinner} ${record.actualScore}` : started ? '等待来源确认' : '等待比赛开始',
        state: resolved ? 'complete' : 'current',
      },
      {
        label: 'AI 复盘',
        detail: reviewComplete ? '复盘已保存' : resolved ? `状态 ${record.postmatchAiStatus ?? '等待生成'}` : '赛果入库后启动',
        state: reviewComplete ? 'complete' : resolved ? 'current' : 'pending',
      },
    ],
  };
}

export function intervalLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
  return `每 ${Math.round(seconds / 60)} 分钟`;
}
import type { PredictionRecord } from './vct-types';
