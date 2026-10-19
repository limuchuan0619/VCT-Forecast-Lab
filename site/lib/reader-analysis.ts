import type { PredictionSnapshot, PredictionRecord } from './vct-types.ts';
import { sourceTeamNames } from './source-team-identities.ts';

export function predictionHeadline(record: PredictionSnapshot) {
  const p = record.teamAProbability;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return '胜率暂时无法显示';
  if (Math.abs(p - 0.5) <= 0.05 + 1e-10) return '双方接近五五开';
  const team = p > 0.5 ? record.teamA : record.teamB;
  return Math.max(p, 1 - p) < 0.6 ? `${team} 稍占优势` : `更看好 ${team}`;
}
export function readerStatus(status?: string | null) {
  if (['SUCCESS', 'complete'].includes(status ?? '')) return '已完成';
  if (['FINAL_FAILED', 'failed', 'skipped'].includes(status ?? ''))
    return '暂时无法提供';
  return '正在整理';
}
const factorCopy: Record<string, [string, string]> = {
  team_rating: ['整体实力', '赛前积累的比赛成绩'],
  rating: ['整体实力', '赛前积累的比赛成绩'],
  recent_form: ['近期表现', '近期比赛表现的评估'],
  player_form: ['选手表现', '赛前选手表现的评估'],
  map_pool: ['地图表现', '赛前地图表现的评估'],
  map_strength: ['地图表现', '赛前地图表现的评估'],
  roster_continuity: ['阵容稳定性', '此前观察到的阵容稳定性'],
  roster: ['阵容稳定性', '此前观察到的阵容稳定性'],
  international_experience: ['大赛经验', '此前积累的国际赛经验'],
  international: ['大赛经验', '此前积累的国际赛经验'],
  series_adaptability: ['长系列赛经验', '此前对本场赛制的适应评估'],
  bo_experience: ['长系列赛经验', '此前对本场赛制的适应评估'],
};
export function prematchReasons(record: PredictionSnapshot) {
  const ranked = record.factors
    .filter(
      (f) =>
        factorCopy[f.key] &&
        Number.isFinite(f.probabilityPoints) &&
        Math.abs(f.probabilityPoints) >= 0.05,
    )
    .toSorted(
      (a, b) => Math.abs(b.probabilityPoints) - Math.abs(a.probabilityPoints),
    );
  const favoredA = record.teamAProbability > 0.5;
  const support = ranked
    .filter((f) => f.probabilityPoints > 0 === favoredA)
    .slice(0, 2);
  const counter = ranked.find((f) => f.probabilityPoints > 0 !== favoredA);
  const selected = [...support, ...(counter ? [counter] : [])];
  const saved = record as PredictionRecord;
  const aiOnTime =
    !!saved.prematchAiCreatedAt &&
    Date.parse(saved.prematchAiCreatedAt) < Date.parse(record.scheduledAt) &&
    Date.parse(record.lockedAt) < Date.parse(record.scheduledAt);
  const knownRefs = new Set([
    ...record.factors.map((f) => `factor:${f.key}`),
    ...record.maps.map((m) => `map:${m.map}`),
  ]);
  const reasons = selected.map((f) => {
    const claim = aiOnTime
      ? saved.prematchAnalysis?.key_factors.find(
          (item) =>
            item.factor === f.key &&
            item.direction ===
              (f.probabilityPoints > 0 ? 'team_a' : 'team_b') &&
            item.evidence_ids?.length &&
            item.evidence_ids.every((id) => knownRefs.has(id)) &&
            item.claim &&
            !/factor:|rating_|normalized|\b(?:ACS|ADR|KAST|Rating|Patch)\b|\d+\.\d{2,}|连胜|击败|战胜|首发|指挥|心理|克制/.test(
              item.claim,
            ),
        )?.claim
      : null;
    const team = f.probabilityPoints > 0 ? record.teamA : record.teamB;
    const text =
      f === counter
        ? `${team} 在${factorCopy[f.key][0]}这一项的赛前评估上占优，抵消了对手的部分优势。`
        : f === support[0]
          ? `${factorCopy[f.key][0]}是本场最主要的支持理由：赛前评估更看好 ${team}。`
          : `${factorCopy[f.key][1]}同样偏向 ${team}，与主要判断方向一致。`;
    return {
      key: f.key,
      title: factorCopy[f.key][0],
      text: claim ?? text,
      points: f.probabilityPoints,
    };
  });
  const maps = record.maps
    .filter(
      (m) =>
        Number.isFinite(m.teamAProbability) &&
        m.teamAProbability > 0 &&
        m.teamAProbability < 1 &&
        Math.abs(m.teamAProbability - 0.5) > 0.05,
    )
    .toSorted(
      (a, b) =>
        Math.abs(b.teamAProbability - 0.5) - Math.abs(a.teamAProbability - 0.5),
    )
    .slice(0, 2)
    .map(
      (m) =>
        `${m.map}：赛前更看好 ${m.teamAProbability > 0.5 ? record.teamA : record.teamB}（${(Math.max(m.teamAProbability, 1 - m.teamAProbability) * 100).toFixed(1)}%）。${m.samples ? `双方分别参考了 ${m.samples[0]} 和 ${m.samples[1]} 场地图记录${Math.min(...m.samples) < 5 ? '，场次较少，判断需谨慎' : ''}。` : '没有保存参考场次，判断需谨慎。'}`,
    );
  return {
    reasons,
    maps,
    limit:
      '这里保留的是赛前评估。若没有保存近期具体对手、官方首发或真实游戏版本，便不据此补写连胜、首发变化或版本适应的故事。',
  };
}
const nameKey = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const aliases: Record<string, string[]> = {
  vlr_team_12010: ['Bilibili Gaming'],
  vlr_team_14137: ['Titan Esports Club'],
  vlr_team_7035: ['KOI', 'Movistar KOI'],
  vlr_team_8185: ['DRX'],
};
export function sourceTeamId(name: string) {
  const ids = Object.entries(sourceTeamNames)
    .filter(([id, known]) =>
      [known, ...(aliases[id] ?? [])].some(
        (value) => nameKey(value) === nameKey(name),
      ),
    )
    .map(([id]) => id);
  return ids.length === 1 ? ids[0] : null;
}
export type ReaderPlayer = {
  id: string;
  name: string;
  team: string;
  agent: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  adr: number | null;
  firstKills: number | null;
  firstDeaths: number | null;
};
export type ReaderMap = {
  order: number;
  map: string;
  score: string;
  winner: string;
  openingA: number | null;
  openingB: number | null;
  players: ReaderPlayer[];
  reference: string;
};
export type PositionPair = {
  mapOrder: number;
  map: string;
  agent: string;
  a: ReaderPlayer;
  b: ReaderPlayer;
  references: string[];
};
export type ReaderInsights = {
  analysisStyle?: 'comparison_v2';
  maps: ReaderMap[];
  positions: PositionPair[];
  identityStatus: 'verified' | 'unavailable';
  limits: string[];
};
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
export { cnAgentName as agentName } from './valorant-terms.ts';
export function readerInsights(record: PredictionSnapshot): ReaderInsights {
  const result = record.resultEvidence;
  const aId = sourceTeamId(record.teamA),
    bId = sourceTeamId(record.teamB);
  const verified =
    !!aId && !!bId && aId !== bId && result?.source.sourceId === 'vlr';
  const raw = result?.playerStats ?? [];
  if (record.status !== 'resolved' || !result)
    return {
      maps: [],
      positions: [],
      identityStatus: 'unavailable',
      limits: ['比赛结果尚未确认。'],
    };
  const maps = result.maps.map((map) => {
    const rows = verified
      ? raw.filter((row) => row.mapOrder === map.order)
      : [];
    const complete =
      verified &&
      rows.length === 10 &&
      [aId, bId].every((id) => {
        const group = rows.filter((row) => row.teamId === id);
        return (
          group.length === 5 &&
          group.every(
            (row) =>
              typeof row.playerId === 'string' &&
              typeof row.player === 'string',
          ) &&
          new Set(group.map((row) => row.playerId)).size === 5
        );
      }) &&
      new Set(rows.map((row) => row.playerId)).size === 10;
    const players: ReaderPlayer[] = complete
      ? rows.map((row) => ({
          id: String(row.playerId),
          name: String(row.player).replace(/\s+(VIT|100T|LOUD)$/, ''),
          team: row.teamId === aId ? record.teamA : record.teamB,
          agent:
            typeof row.agent === 'string' && /^[a-z]+$/.test(row.agent)
              ? row.agent
              : null,
          kills: number(row.kills),
          deaths: number(row.deaths),
          assists: number(row.assists),
          adr: number(row.adr),
          firstKills: number(row.firstKills),
          firstDeaths: number(row.firstDeaths),
        }))
      : [];
    const first = (team: string) => {
      const group = players.filter((row) => row.team === team);
      return group.length === 5 && group.every((row) => row.firstKills !== null)
        ? group.reduce((sum, row) => sum + row.firstKills!, 0)
        : null;
    };
    const openingA = first(record.teamA),
      openingB = first(record.teamB);
    const countsValid =
      openingA !== null &&
      openingB !== null &&
      openingA + openingB > 0 &&
      openingA + openingB <= map.teamAScore + map.teamBScore;
    return {
      order: map.order,
      map: map.map,
      score: `${map.teamAScore}:${map.teamBScore}`,
      winner: map.winner,
      openingA: countsValid ? openingA : null,
      openingB: countsValid ? openingB : null,
      players,
      reference: `fact:map:${map.order}`,
    };
  });
  const candidates = maps.flatMap((map) =>
    map.players
      .filter((player) => player.team === record.teamA && player.agent)
      .flatMap((a) => {
        const aa = map.players.filter(
            (p) => p.team === record.teamA && p.agent === a.agent,
          ),
          bb = map.players.filter(
            (p) => p.team === record.teamB && p.agent === a.agent,
          );
        if (aa.length !== 1 || bb.length !== 1) return [];
        const b = bb[0];
        if (
          [
            a.kills,
            a.deaths,
            b.kills,
            b.deaths,
            a.firstKills,
            a.firstDeaths,
            b.firstKills,
            b.firstDeaths,
          ].some((v) => v === null)
        )
          return [];
        return [
          {
            mapOrder: map.order,
            map: map.map,
            agent: a.agent!,
            a,
            b,
            references: [
              map.reference,
              `fact:reader-player:${map.order}:${a.id}`,
              `fact:reader-player:${map.order}:${b.id}`,
            ],
          },
        ];
      }),
  );
  const positions: PositionPair[] = [];
  for (const pair of candidates)
    if (
      !positions.some(
        (p) => p.mapOrder === pair.mapOrder && p.agent === pair.agent,
      )
    )
      positions.push(pair);
  return {
    analysisStyle: 'comparison_v2',
    maps,
    positions,
    identityStatus: verified ? 'verified' : 'unavailable',
    limits: [
      '同特工比较不是两人直接交火的战绩。',
      '没有完整攻防、经济和回合过程，无法确定具体战术或关键回合原因。',
      ...(!verified ? ['选手队伍归属未能核验，暂不作分队和位置比较。'] : []),
    ],
  };
}
export type ReaderReviewClaim = {
  title?: string;
  fact: string;
  interpretation: string;
  evidence_ids: string[];
};
export type ReaderReview = {
  summary: string;
  reasons: ReaderReviewClaim[];
  maps: Array<{
    order: number;
    map: string;
    fact: string;
    interpretation: string;
    evidence_ids: string[];
  }>;
  matchups: Array<{
    mapOrder: number;
    agent: string;
    playerAId: string;
    playerBId: string;
    fact: string;
    interpretation: string;
    evidence_ids: string[];
  }>;
};
// Some provider responses wrap a complete claim inside its `fact` property.
// Unwrap only that exact, lossless shape. Never invent/rename IDs, repair facts,
// discard conflicting metadata, or bypass the ordinary evidence validator.
export function normalizeReaderReview(value: unknown): ReaderReview {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(value)) return value as ReaderReview;
  const unwrap = (v: unknown, keys: string[]) => {
    if (!object(v) || !object(v.fact)) return v;
    const nested = v.fact;
    if (
      typeof nested.fact !== 'string' ||
      typeof nested.interpretation !== 'string' ||
      !Array.isArray(nested.evidence_ids)
    )
      return v;
    const allowed = new Set([
      'fact',
      'interpretation',
      'evidence_ids',
      ...keys,
    ]);
    if (
      [...Object.keys(v), ...Object.keys(nested)].some((k) => !allowed.has(k))
    )
      return v;
    const merged = { ...v };
    delete merged.fact;
    for (const [key, item] of Object.entries(nested)) {
      if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(item))
        return v;
      merged[key] = item;
    }
    return merged;
  };
  return {
    ...value,
    reasons: Array.isArray(value.reasons)
      ? value.reasons.map((v) => unwrap(v, ['title']))
      : value.reasons,
    maps: Array.isArray(value.maps)
      ? value.maps.map((v) => unwrap(v, ['order', 'map']))
      : value.maps,
    matchups: Array.isArray(value.matchups)
      ? value.matchups.map((v) =>
          unwrap(v, ['mapOrder', 'agent', 'playerAId', 'playerBId']),
        )
      : value.matchups,
  } as ReaderReview;
}

export function validateReaderReview(
  value: unknown,
  insights: ReaderInsights,
  references: string[],
) {
  const v = value as ReaderReview;
  if (
    !v ||
    typeof v.summary !== 'string' ||
    !v.summary.trim() ||
    v.summary.length > 180 ||
    !Array.isArray(v.reasons) ||
    v.reasons.length > 3 ||
    !Array.isArray(v.maps) ||
    !Array.isArray(v.matchups) ||
    v.matchups.length > 2
  )
    throw new Error('schema_reader_review');
  const refs = new Set(references.filter((ref) => ref.startsWith('fact:')));
  for (const item of [...v.maps, ...v.matchups]) {
    const order = 'order' in item ? item.order : item.mapOrder;
    const map = insights.maps.find((m) => m.order === order);
    const rounds = map?.score
      .split(':')
      .map(Number)
      .reduce((a, b) => a + b, 0);
    if (
      !rounds ||
      typeof item.fact !== 'string' ||
      typeof item.interpretation !== 'string'
    )
      continue;
    for (const match of (item.fact + ' ' + item.interpretation).matchAll(
      /(?:首杀|首死)(?:\s|为|合计|分别|累计|次数|是|以|达到)*(\d+)(?:\s*(?:比|对|:|：)\s*(\d+))?/g,
    ))
      if (Number(match[1]) > rounds || (match[2] && Number(match[2]) > rounds))
        throw new Error('schema_reader_impossible_opening_count');
  }
  if (
    insights.analysisStyle === 'comparison_v2' &&
    /中后[期段]|回合控制|控图|关键回合|战术压制|残局|首杀转化率|心理崩溃|前压|推进空间|定位阶段|枪械|回合效率|更擅长/.test(
      [
        v.summary,
        ...v.reasons.flatMap((x) => [x.title, x.fact, x.interpretation]),
        ...v.maps.flatMap((x) => [x.fact, x.interpretation]),
        ...v.matchups.flatMap((x) => [x.fact, x.interpretation]),
      ].join('\n'),
    )
  )
    throw new Error('schema_reader_unsupported_timeline_claim');
  const valid = (item: {
    fact: string;
    interpretation: string;
    evidence_ids: string[];
  }) =>
    typeof item?.fact === 'string' &&
    item.fact.trim() &&
    item.fact.length <= 240 &&
    typeof item.interpretation === 'string' &&
    item.interpretation.length <= 240 &&
    !/factor:|readerInsights|schema|artifact|normalized|rating_offset|Brier|Log Loss|MODEL SIGNAL|HYPOTHESIS/.test(
      item.fact + item.interpretation,
    ) &&
    Array.isArray(item.evidence_ids) &&
    item.evidence_ids.length > 0 &&
    item.evidence_ids.length <= 8 &&
    item.evidence_ids.every((id) => refs.has(id));
  if (
    v.reasons.some(
      (item) =>
        (item.title !== undefined &&
          (typeof item.title !== 'string' ||
            !item.title.trim() ||
            item.title.length > 60)) ||
        !valid(item),
    )
  )
    throw new Error('schema_reader_reason');
  if (
    v.maps.length !== insights.maps.length ||
    new Set(v.maps.map((m) => m.order)).size !== v.maps.length ||
    v.maps.some(
      (item) =>
        !valid(item) ||
        !insights.maps.some(
          (map) =>
            map.order === item.order &&
            map.map === item.map &&
            item.evidence_ids.includes(map.reference) &&
            item.evidence_ids.every(
              (ref) =>
                ref === map.reference ||
                ref.startsWith(`fact:reader-player:${map.order}:`),
            ),
        ),
    )
  )
    throw new Error('schema_reader_map_binding');
  if (
    v.matchups.some(
      (item) =>
        !valid(item) ||
        !insights.positions.some(
          (pair) =>
            pair.mapOrder === item.mapOrder &&
            pair.agent === item.agent &&
            pair.a.id === item.playerAId &&
            pair.b.id === item.playerBId &&
            item.evidence_ids.every((ref) => pair.references.includes(ref)) &&
            pair.references
              .slice(1)
              .every((ref) => item.evidence_ids.includes(ref)),
        ),
    )
  )
    throw new Error('schema_reader_matchup_binding');
}
