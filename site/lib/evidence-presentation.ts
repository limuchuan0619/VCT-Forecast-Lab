import type { AnalysisPacket } from './ai-reliability.ts';
import type { FactorContribution, PredictionRecord } from './vct-types.ts';
import {
  factorName,
  modelProbabilities,
  plainText,
  resultSentence,
  reviewSummary,
} from './presentation.ts';

export type EvidenceItem = {
  reference: string;
  title: string;
  text: string;
  kind: 'prematch' | 'postmatch' | 'model' | 'missing';
};
export function frozenFactorReading(
  factor: FactorContribution,
  record: PredictionRecord,
): string {
  const pair = /^A\s+([+-]?\d+(?:\.\d+)?)\s*\/\s*B\s+([+-]?\d+(?:\.\d+)?)/.exec(
    factor.detail,
  );
  if (!pair)
    return plainText(factor.detail, record) || '未保存原始数值，不补造依据。';
  const a = Number(pair[1]),
    b = Number(pair[2]);
  const unit =
    factor.key === 'team_rating'
      ? '赛前实力评分'
      : factor.key === 'map_pool'
        ? '相对整体实力的地图评分'
        : '赛前模型评分（不是胜率）';
  return `${record.teamA} ${a.toFixed(factor.key === 'team_rating' ? 1 : 3)}；${record.teamB} ${b.toFixed(factor.key === 'team_rating' ? 1 : 3)}。${unit}，来自当时保存的记录。`;
}

export function prematchReading(record: PredictionRecord) {
  const favoredA = record.teamAProbability > 0.5;
  const tied = record.teamAProbability === 0.5;
  const ranked = record.factors
    .filter((f) => Number.isFinite(f.probabilityPoints))
    .toSorted(
      (a, b) => Math.abs(b.probabilityPoints) - Math.abs(a.probabilityPoints),
    );
  const supports = tied
    ? []
    : ranked
        .filter(
          (f) =>
            Math.abs(f.probabilityPoints) >= 0.005 &&
            f.probabilityPoints > 0 === favoredA,
        )
        .slice(0, 2);
  const counters = tied
    ? []
    : ranked
        .filter(
          (f) =>
            Math.abs(f.probabilityPoints) >= 0.005 &&
            f.probabilityPoints > 0 !== favoredA,
        )
        .slice(0, 2);
  const close = ranked
    .filter((f) => Math.abs(f.probabilityPoints) < 0.005)
    .slice(0, 2);
  const warnings: string[] = [];
  if (!ranked.length) warnings.push('未保存因素明细，无法重建具体理由。');
  const thinMaps = record.maps.filter(
    (m) => m.samples && m.samples.some((n) => n < 5),
  );
  if (thinMaps.length)
    warnings.push(
      `部分地图历史样本较少：${thinMaps.map((m) => `${m.map}（${m.samples![0]} / ${m.samples![1]} 场）`).join('、')}。这只是样本提醒，不会改动已保存的胜率。`,
    );
  if (!record.maps.length) warnings.push('没有保存地图概率，不推测本场选图。');
  if (
    record.evidence.patchProvenance.includes('cohort') ||
    record.evidence.patchProvenance.includes('unavailable')
  )
    warnings.push(
      '赛事环境因素使用赛事分组代替信息，不是真实游戏版本，也不是已确认的版本适应能力。',
    );
  if (modelProbabilities(record).c1 !== null && record.challenger) {
    const missing = Object.entries(record.challenger.featureStatus).filter(
      ([, s]) => s !== 'observed',
    );
    if (missing.length)
      warnings.push(
        `C1 的 ${missing.length} 项输入带有缺失或估算标记，可在赛前指标详情核查；这不等同于正式模型缺失相同字段。`,
      );
  }
  warnings.push(
    '没有冻结的官方首发或真实选图证据时，不将本场实际阵容和地图倒填为赛前依据。',
  );
  return {
    favored: tied ? null : favoredA ? record.teamA : record.teamB,
    supports,
    counters,
    close,
    warnings,
  };
}

export function postmatchPacketMatchesRecord(
  packet: AnalysisPacket,
  record: PredictionRecord,
): boolean {
  const p = packet?.prediction;
  if (
    packet?.schemaVersion !== 'v1.4c-r2-analysis-packet-v1' ||
    !p ||
    record.status !== 'resolved' ||
    !record.resultEvidence ||
    !record.scorecard ||
    !Array.isArray(packet.maps) ||
    !Array.isArray(packet.playerOutliers) ||
    !Array.isArray(packet.evidenceReferences) ||
    p.predictionId !== record.id ||
    p.lockedAt !== record.lockedAt ||
    p.scheduledAt !== record.scheduledAt ||
    p.teamA !== record.teamA ||
    p.teamB !== record.teamB ||
    p.championProbabilityTeamA !== record.teamAProbability ||
    p.predictedScore !== record.predictedScore ||
    p.actualWinner !== record.actualWinner ||
    p.actualScore !== record.actualScore ||
    p.resultCapturedAt !== record.resultEvidence.source.capturedAt
  )
    return false;
  return (
    packet.maps.length === record.resultEvidence.maps.length &&
    packet.maps.every((map) =>
      record.resultEvidence!.maps.some(
        (m) =>
          m.order === map.order &&
          m.map === map.map &&
          `${m.teamAScore}-${m.teamBScore}` === map.score &&
          m.winner === map.winner,
      ),
    )
  );
}

export function evidenceItem(
  record: PredictionRecord,
  reference: string,
): EvidenceItem {
  const missing = {
    reference,
    title: '引用暂不可核验',
    text: '未找到与这段分析匹配的保存证据，或证据已被较新赛果修订替代。原始引用保留在技术记录中，不补造依据。',
    kind: 'missing' as const,
  };
  const factor = record.factors.find((f) => reference === `factor:${f.key}`);
  if (factor)
    return {
      reference,
      title: factorName(factor.key, factor.label),
      text: frozenFactorReading(factor, record),
      kind: 'prematch',
    };
  const candidateMap = record.maps.find((m) => reference === `map:${m.map}`);
  if (candidateMap)
    return {
      reference,
      title: `${candidateMap.map} · 赛前候选地图`,
      text: `${record.teamA} 胜率 ${(candidateMap.teamAProbability * 100).toFixed(1)}%，${record.teamB} 胜率 ${(candidateMap.teamBProbability * 100).toFixed(1)}%。${candidateMap.samples ? `双方历史样本 ${candidateMap.samples[0]} / ${candidateMap.samples[1]} 场。` : '历史样本数量未保存。'}不代表实际选图已确定。`,
      kind: 'prematch',
    };
  if (reference === 'prediction:locked_snapshot')
    return {
      reference,
      title: '当时的赛前判断',
      text: `${record.teamA} 胜率 ${(record.teamAProbability * 100).toFixed(1)}%，预测 ${record.predictedScore.replace('-', ':')}；保存于 ${record.lockedAt}。${record.factors.map((f) => `${factorName(f.key, f.label)}：${frozenFactorReading(f, record)}`).join(' ')}`,
      kind: 'prematch',
    };
  const packet = record.postmatchEvidence;
  if (
    !packet ||
    !postmatchPacketMatchesRecord(packet, record) ||
    !packet.evidenceReferences.includes(reference)
  )
    return missing;
  if (reference === 'system:scorecard')
    return {
      reference,
      title: '系统核对的命中情况',
      text: reviewSummary(record),
      kind: 'model',
    };
  if (reference === 'fact:result_evidence')
    return {
      reference,
      title: '已确认的系列赛结果',
      text: resultSentence(record),
      kind: 'postmatch',
    };
  const map = packet.maps.find((m) => reference === `fact:map:${m.order}`);
  if (map)
    return {
      reference,
      title: `第 ${map.order} 图 · ${map.map}`,
      text: `${record.teamA} : ${record.teamB} 为 ${map.score.replace('-', ':')}；${map.winner} 获胜。`,
      kind: 'postmatch',
    };
  const player = packet.playerOutliers.find(
    (p) => reference === `fact:player:${p.mapOrder}:${p.playerId ?? p.player}`,
  );
  if (player) {
    const labels: Record<string, string> = {
      rating: '综合评分',
      acs: '平均战斗评分',
      kills: '击杀',
      deaths: '死亡',
      assists: '助攻',
      adr: '每回合伤害',
      kast: '有效参与回合比例',
      firstKills: '首杀',
      firstDeaths: '首死',
    };
    const stats = Object.entries(labels).flatMap(([key, label]) => {
      const m = player.metrics[key];
      return m?.status === 'observed' && m.value !== null
        ? [`${label} ${m.value}`]
        : [];
    });
    return {
      reference,
      title: `${player.player} · ${player.map}`,
      text: `${stats.join('；') || '没有可展示的选手数值'}。这些是赛后观测，不是赛前状态，也不能单独证明输赢原因。`,
      kind: 'postmatch',
    };
  }
  return missing;
}

export function missingEvidenceName(key: string): string {
  return (
    (
      {
        attack_defense: '攻守两侧表现',
        veto_bp: '实际禁选图过程',
        actual_played_at: '实际开赛时间',
        prematch_player_map_baseline: '冻结的选手赛前地图表现',
        prematch_expected_roster: '冻结的官方赛前首发',
        economy: '经济与买枪情况',
        pistol_rounds: '手枪局过程',
        clutch: '残局过程',
        round_timeline: '逐回合过程',
      } as Record<string, string>
    )[key] ?? '其他未保存的比赛背景信息（原字段见技术记录）'
  );
}
