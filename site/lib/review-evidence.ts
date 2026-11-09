import type {
  ReaderInsights,
  ReaderReview,
  ReaderPlayer,
} from './reader-analysis.ts';
import { validateReaderReview } from './reader-analysis.ts';
import { cnAgentName } from './valorant-terms.ts';

export const EVIDENCE_REVIEW_PROMPT = 'vct-postmatch-deepseek-v20-balanced1';
export const EVIDENCE_REVIEW_POLICY = 'facts-first-advisory-v1';
export const EVIDENCE_REVIEW_SCHEMA = 'v1.4c-reader-evidence-analysis-v1';
export type Observation = {
  id: string;
  kind: 'series' | 'map' | 'matchup';
  order?: number;
  map?: string;
  agent?: string;
  playerAId?: string;
  playerBId?: string;
  scores?: string[];
  fact: string;
  evidence_ids: string[];
};
export type EvidenceSelection = {
  summary: string;
  summary_observations: string[];
  reasons: Array<{
    observation_id: string;
    title: string;
    interpretation: string;
  }>;
  maps: Array<{
    order: number;
    observation_id: string;
    interpretation: string;
  }>;
  matchups: Array<{ observation_id: string; interpretation: string }>;
};
const playerRef = (order: number, p: ReaderPlayer) =>
  `fact:reader-player:${order}:${p.id}`;
const unique = (values: string[]) => [...new Set(values)];

// Only supplied, identity-checked rows are used. A factual anchor is rendered by
// code; the provider selects useful observations and writes their interpretation.
// This prevents a valid citation from laundering an invented statistic.
export function reviewObservations(
  insights: ReaderInsights,
  teams: [string, string],
): Observation[] {
  const out: Observation[] = [];
  for (const map of insights.maps) {
    out.push({
      id: `map:${map.order}:result`,
      kind: 'map',
      order: map.order,
      map: map.map,
      fact: `${map.map}的比分为 ${map.score}（${teams[0]} : ${teams[1]}），${map.winner}取胜。`,
      evidence_ids: [map.reference],
    });
    if (map.openingA !== null && map.openingB !== null)
      out.push({
        id: `map:${map.order}:opening`,
        kind: 'map',
        order: map.order,
        map: map.map,
        fact: `${map.map}整图累计首杀，${teams[0]}为${map.openingA}次，${teams[1]}为${map.openingB}次。`,
        evidence_ids: [map.reference],
      });
    const leaders = teams.map((team) => {
      const rows = map.players.filter((p) => p.team === team);
      return rows.length === 5 && rows.every((p) => p.kills !== null)
        ? rows.sort(
            (a, b) => b.kills! - a.kills! || a.id.localeCompare(b.id),
          )[0]
        : undefined;
    });
    if (leaders.every(Boolean)) {
      const [a, b] = leaders as ReaderPlayer[];
      out.push({
        id: `map:${map.order}:leaders`,
        kind: 'map',
        order: map.order,
        map: map.map,
        fact: `${map.map}双方队内最高击杀选手中，${a.name}（${a.team}）${a.kills}杀${a.adr !== null ? `、每回合伤害${a.adr}` : ''}；${b.name}（${b.team}）${b.kills}杀${b.adr !== null ? `、每回合伤害${b.adr}` : ''}。`,
        evidence_ids: [
          map.reference,
          playerRef(map.order, a),
          playerRef(map.order, b),
        ],
      });
    }
    const pairs = insights.positions
      .filter((p) => p.mapOrder === map.order)
      .sort((a, b) => {
        const gap = (p: typeof a) =>
          p.a.adr !== null && p.b.adr !== null
            ? Math.abs(p.a.adr - p.b.adr)
            : Math.abs(p.a.kills! - p.b.kills!);
        return gap(b) - gap(a);
      })
      .slice(0, 2);
    for (const pair of pairs) {
      out.push({
        id: `pair:${map.order}:${pair.agent}`,
        kind: 'matchup',
        order: map.order,
        map: map.map,
        agent: pair.agent,
        playerAId: pair.a.id,
        playerBId: pair.b.id,
        fact: `${map.map}同用${cnAgentName(pair.agent)}：${pair.a.name}（${pair.a.team}）${pair.a.kills}杀${pair.a.adr !== null ? `、每回合伤害${pair.a.adr}` : ''}；${pair.b.name}（${pair.b.team}）${pair.b.kills}杀${pair.b.adr !== null ? `、每回合伤害${pair.b.adr}` : ''}。`,
        evidence_ids: pair.references,
      });
    }
  }
  const refs = insights.maps.map((m) => m.reference);
  if (insights.maps.length)
    out.unshift({
      id: 'series:map-differences',
      kind: 'series',
      scores: [
        `${insights.maps.filter((m) => m.winner === teams[0]).length}:${insights.maps.filter((m) => m.winner === teams[1]).length}`,
      ],
      fact:
        insights.maps
          .map((m) => `${m.map}${m.score}，${m.winner}取胜`)
          .join('；') + '（比分按双方队名顺序）。',
      evidence_ids: refs,
    });
  for (const team of teams) {
    const won = insights.maps.filter((m) => m.winner === team);
    const leaders = won.map((map) => {
      const rows = map.players.filter((p) => p.team === team);
      return {
        map,
        player:
          rows.length === 5 && rows.every((p) => p.kills !== null)
            ? rows.sort(
                (a, b) => b.kills! - a.kills! || a.id.localeCompare(b.id),
              )[0]
            : undefined,
      };
    });
    if (leaders.length > 1 && leaders.every((item) => item.player))
      out.unshift({
        id: `series:leaders:${teams.indexOf(team)}`,
        kind: 'series',
        fact:
          `${team}的胜图中，` +
          leaders
            .map(
              ({ map, player }) =>
                `${map.map}队内最高击杀者包括${player!.name}（${player!.kills}杀）`,
            )
            .join('；') +
          '。',
        evidence_ids: unique(
          leaders.flatMap(({ map, player }) => [
            map.reference,
            playerRef(map.order, player!),
          ]),
        ),
      });
  }
  return out.filter(
    (item) => item.fact.length <= 240 && item.evidence_ids.length <= 8,
  );
}

export function evidenceSelectionSchema(
  observations: Observation[],
  insights: ReaderInsights,
  numericGuard = false,
) {
  const entities = [
    ...new Set(
      insights.maps.flatMap((m) => [
        m.map,
        ...m.players.flatMap((p) => [p.name, p.team]),
      ]),
    ),
  ];
  const numericNames = entities
    .filter((name) => /\d/.test(name))
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Digits inside exact source names (e.g. 100 Thieves) remain legal; new
  // statistical numbers belong to the server-rendered fact, not AI prose.
  const proseRule = numericGuard
    ? {
        pattern: `^(?:[^0-9]${numericNames.length ? '|' + numericNames.join('|') : ''})*$`,
      }
    : {};
  const claim = (ids: string[]) => ({
    type: 'object',
    additionalProperties: false,
    properties: {
      observation_id: { type: 'string', enum: ids },
      interpretation: { type: 'string', maxLength: 220, ...proseRule },
    },
    required: ['observation_id', 'interpretation'],
  });
  const reason = claim(
    observations.filter((o) => o.kind !== 'matchup').map((o) => o.id),
  );
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 180, ...proseRule },
      summary_observations: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: { type: 'string', enum: observations.map((o) => o.id) },
      },
      reasons: {
        type: 'array',
        maxItems: 2,
        items: {
          ...reason,
          properties: {
            ...reason.properties,
            title: { type: 'string', maxLength: 60, ...proseRule },
          },
          required: [...reason.required, 'title'],
        },
      },
      maps: {
        type: 'array',
        minItems: insights.maps.length,
        maxItems: insights.maps.length,
        items: {
          anyOf: insights.maps.map((map) => {
            const c = claim(
              observations
                .filter((o) => o.kind === 'map' && o.order === map.order)
                .map((o) => o.id),
            );
            return {
              ...c,
              properties: {
                ...c.properties,
                order: { type: 'integer', const: map.order },
              },
              required: [...c.required, 'order'],
            };
          }),
        },
      },
      matchups: {
        type: 'array',
        maxItems: Math.min(
          2,
          observations.filter((o) => o.kind === 'matchup').length,
        ),
        items: observations.some((o) => o.kind === 'matchup')
          ? claim(
              observations.filter((o) => o.kind === 'matchup').map((o) => o.id),
            )
          : { type: 'object' },
      },
    },
    required: [
      'summary',
      'summary_observations',
      'reasons',
      'maps',
      'matchups',
    ],
  };
}

export function assembleEvidenceReview(
  selection: EvidenceSelection,
  observations: Observation[],
  insights: ReaderInsights,
  refs: string[],
  options: {
    advisory?: boolean;
    onWarning?: (issue: { path: string; reason: string }) => void;
  } = {},
): ReaderReview {
  const index = new Map(observations.map((o) => [o.id, o]));
  const allowedEntities = [
    ...insights.maps.map((m) => m.map),
    ...insights.maps.flatMap((m) => m.players.flatMap((p) => [p.name, p.team])),
  ];
  const validationIssues: Array<{ path: string; reason: string }> = [];
  const stripEntities = (text: string) => {
    for (const name of [...allowedEntities].sort((a, b) => b.length - a.length))
      text = text.split(name).join('');
    return text;
  };
  const numbers = (text: string) =>
    [...stripEntities(text).matchAll(/\d+(?:\.\d+)?/g)].map((m) =>
      Number(m[0]),
    );
  const prose = (
    text: unknown,
    max: number,
    path: string,
    sources: Observation[],
  ) => {
    if (typeof text !== 'string' || !text.trim() || text.length > max)
      throw Object.assign(new Error('schema_evidence_prose'), {
        validationIssues: [{ path, reason: 'empty_or_too_long' }],
      });
    const stripped = stripEntities(text);
    if (/\d/.test(stripped)) {
      if (!options.advisory)
        validationIssues.push({
          path,
          reason: 'numeric_prose_use_server_fact',
        });
      else {
        const known = new Set(
          sources.flatMap((o) => [
            ...numbers(o.fact),
            ...(o.order ? [o.order] : []),
          ]),
        );
        const maps = insights.maps.filter((m) =>
          sources.some((o) => o.kind === 'series' || o.order === m.order),
        );
        // Scores have their own source-bound check; a valid individual digit
        // must not make an invented score valid. Series order comes from facts.
        const scores = new Set(maps.map((m) => m.score));
        for (const score of sources.flatMap((o) => o.scores ?? [])) {
          scores.add(score);
          score.split(':').forEach((n) => known.add(Number(n)));
        }
        const wrongScore = [
          ...stripped.matchAll(/(\d+)\s*[:：-]\s*(\d+)/g),
        ].some((m) => !scores.has(`${Number(m[1])}:${Number(m[2])}`));
        if (numbers(text).some((n) => !known.has(n)) || wrongScore)
          validationIssues.push({
            path,
            reason: 'numeric_fact_not_in_selected_evidence',
          });
        else
          options.onWarning?.({ path, reason: 'source_numeric_restatement' });
      }
    }
    if (
      /残局|控图|关键回合|中路控制|补枪|被针对|战术压制|回防|转点|道具衔接|经济链|心理|首杀.{0,12}(?:转化|之后|后更|后仍)|完成先手后|更难被反制|整体减员效率|直接导致|因而获胜|因此获胜/.test(
        stripped,
      )
    )
      options.advisory
        ? options.onWarning?.({
            path,
            reason: 'interpretation_not_verified_match_process',
          })
        : validationIssues.push({ path, reason: 'unsupported_match_process' });
    return text;
  };
  if (
    !selection ||
    !Array.isArray(selection.summary_observations) ||
    !selection.summary_observations.length ||
    selection.summary_observations.length > 3 ||
    selection.summary_observations.some((id) => !index.has(id)) ||
    !Array.isArray(selection.reasons) ||
    selection.reasons.length > 2 ||
    !Array.isArray(selection.maps) ||
    !Array.isArray(selection.matchups) ||
    selection.matchups.length > 2
  )
    throw new Error('schema_evidence_selection');
  const used = new Set<string>();
  const claim = (
    item: { observation_id: string; interpretation: string },
    kind?: Observation['kind'],
    order?: number,
    path = 'interpretation',
  ) => {
    const obs = index.get(item?.observation_id);
    if (
      !obs ||
      (!options.advisory && used.has(obs.id)) ||
      (kind && obs.kind !== kind) ||
      (order !== undefined && obs.order !== order)
    )
      throw new Error('schema_evidence_observation_binding');
    if (used.has(obs.id))
      options.onWarning?.({ path, reason: 'repeated_observation' });
    used.add(obs.id);
    return {
      obs,
      fact: obs.fact,
      interpretation: prose(item.interpretation, 220, path, [obs]),
      evidence_ids: obs.evidence_ids,
    };
  };
  const review: ReaderReview = {
    summary: prose(
      selection.summary,
      180,
      'summary',
      selection.summary_observations.map((id) => index.get(id)!),
    ),
    reasons: selection.reasons.map((item, i) => {
      const { obs, ...entry } = claim(
        item,
        undefined,
        undefined,
        `reasons[${i}].interpretation`,
      );
      if (obs.kind === 'matchup')
        throw new Error('schema_evidence_reason_kind');
      return {
        ...entry,
        title: prose(item.title, 60, `reasons[${i}].title`, [obs]),
      };
    }),
    maps: selection.maps.map((item, i) => {
      const { obs, ...entry } = claim(
        item,
        'map',
        item.order,
        `maps[${i}].interpretation`,
      );
      return { ...entry, order: item.order, map: obs.map! };
    }),
    matchups: selection.matchups.map((item, i) => {
      const { obs, ...entry } = claim(
        item,
        'matchup',
        undefined,
        `matchups[${i}].interpretation`,
      );
      return {
        ...entry,
        mapOrder: obs.order!,
        agent: obs.agent!,
        playerAId: obs.playerAId!,
        playerBId: obs.playerBId!,
      };
    }),
  };
  if (validationIssues.length)
    throw Object.assign(new Error('schema_evidence_unproven_interpretation'), {
      validationIssues,
    });
  validateReaderReview(review, insights, refs, { advisory: options.advisory });
  return review;
}

export function validateEvidenceArticle(
  value: Record<string, unknown>,
  insights: ReaderInsights,
  teams: [string, string],
  refs: string[],
) {
  const review = assembleEvidenceReview(
    value.reader_evidence_selection as EvidenceSelection,
    reviewObservations(insights, teams),
    insights,
    refs,
    { advisory: value.reader_editorial_policy === EVIDENCE_REVIEW_POLICY },
  );
  if (JSON.stringify(review) !== JSON.stringify(value.reader_review))
    throw new Error('schema_evidence_article_changed');
}

export const evidenceReviewInstruction = `你是无畏契约赛事分析编辑，为普通观众解释本场比赛，而不是念统计表。
事实锚点observations已由系统核对。只用observation_id选择论据，禁止重写事实数字、地图或选手归属。summary_observations给出总判断的依据。
summary先给有辨识度的比赛判断；reasons最多两条，只在有独立观察时写，至少照顾输方有竞争力的部分；maps每张图选一项有解释价值的观察，解释它与其他图有何差异。matchups最多两组，仅在补充了新观察时写，否则留空。
interpretation回答这个事实如何改变对本图的理解，不能只是换词重复“输出更好”。数字由系统呈现，summary/title/interpretation不再写数字或新统计。同一observation不能重复出现在各栏目；总览讲跨图格局，分图和同英雄比较不要重复同一组数据。
首杀/首死只是全图累计，不能推出首杀后是否存活、被交易、首杀转化率或战术过程。没有录像、攻防、回合和经济记录，不写残局、控图、补枪、针对、回防、关键回合、心理或确定输因。同英雄不等于相同职责或直接交手；缺少个人历史基线不写超常发挥/状态下滑。
不要写五人伤害合计。允许说明总比分与各图接近程度的反差、不同地图输出贡献的变化、一个指标领先并不等于整体表现领先。观点必须由所选事实支持；证据薄弱时明确只能比较当前表现，不用泛泛的执行力和节奏填充。每段解释约四十至八十字，地图间不要套同一句话。只返回指定JSON。`;

export const advisoryEvidenceReviewInstruction = `为普通无畏契约观众写自然的比赛解读。系统提供已核实的observations，你只选择正确的observation_id并写解释，不改地图、选手归属、赛果或正式胜率。
summary概括本场，reasons最多两条，maps逐图各一个重点，matchups最多两组。事实栏由系统填入；解释可以简短复述所选事实已有的数字，也可以跨栏目引用同一事实，不必为了避免重复生造观点。
可以讨论输出支点、首杀优势、地图间反差和可能的胜负原因。推断用“可能”“更像”“从这些表现看”等自然表述，不需要逐句证明或反复免责声明。无法由统计确认的战术、经济、关键回合过程不能写成亲眼观察的事实；同英雄比较不等于两人直接交火。
优先提供有用、简洁的分析，不以语言是否完美为目标，不输出内部计算术语。没有资料时少说，不编造数字或具体比赛过程。只返回指定JSON。`;
