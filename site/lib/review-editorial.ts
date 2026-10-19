import type { ReaderInsights } from './reader-analysis.ts';

// Opt-in single-record writing trial. Not a model feature, training input or
// automatic-job upgrade. All arithmetic is descriptive of this finished match.
export const EDITORIAL_REVIEW_PROMPT =
  'vct-postmatch-deepseek-v17-editorial-trial';
export const EDITORIAL_REVIEW_SCHEMA = 'v1.4c-reader-editorial-trial-v1';

export function editorialEvidence(
  insights: ReaderInsights,
  teams: [string, string],
) {
  return insights.maps.map((map) => ({
    order: map.order,
    map: map.map,
    reference: map.reference,
    teams: teams.map((team) => {
      const rows = map.players.filter((p) => p.team === team);
      const sum = (key: 'kills' | 'deaths' | 'firstKills' | 'firstDeaths') =>
        rows.length === 5 && rows.every((p) => p[key] !== null)
          ? rows.reduce((n, p) => n + p[key]!, 0)
          : null;
      const kills = sum('kills');
      const leaders =
        kills !== null && kills > 0
          ? [...rows]
              .sort((a, b) => b.kills! - a.kills!)
              .slice(0, 2)
              .map((p) => ({
                playerId: p.id,
                name: p.name,
                kills: p.kills,
                shareOfTeamKills: p.kills! / kills,
                reference: `fact:reader-player:${map.order}:${p.id}`,
              }))
          : [];
      return {
        team,
        kills,
        deaths: sum('deaths'),
        firstKills: sum('firstKills'),
        firstDeaths: sum('firstDeaths'),
        leaders,
      };
    }),
  }));
}

const planClaim = {
  type: 'object',
  additionalProperties: false,
  properties: {
    angle: { type: 'string', minLength: 1, maxLength: 220 },
    evidence_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string' },
    },
    limit: { type: 'string', minLength: 1, maxLength: 180 },
  },
  required: ['angle', 'evidence_ids', 'limit'],
};
export const editorialPlanSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    thesis: { type: 'string', minLength: 1, maxLength: 180 },
    findings: { type: 'array', maxItems: 3, items: planClaim },
    maps: {
      type: 'array',
      maxItems: 5,
      items: {
        ...planClaim,
        properties: {
          ...planClaim.properties,
          order: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: [...planClaim.required, 'order'],
      },
    },
  },
  required: ['thesis', 'findings', 'maps'],
};
export type EditorialPlan = {
  thesis: string;
  findings: Array<{ angle: string; evidence_ids: string[]; limit: string }>;
  maps: Array<{
    order: number;
    angle: string;
    evidence_ids: string[];
    limit: string;
  }>;
};
export function editorialPlanSchemaFor(
  insights: ReaderInsights,
  references: string[],
) {
  const facts = references.filter((id) => id.startsWith('fact:'));
  return {
    ...editorialPlanSchema,
    properties: {
      ...editorialPlanSchema.properties,
      findings: {
        ...editorialPlanSchema.properties.findings,
        items: {
          ...planClaim,
          properties: {
            ...planClaim.properties,
            evidence_ids: {
              ...planClaim.properties.evidence_ids,
              items: { type: 'string', enum: facts },
            },
          },
        },
      },
      maps: {
        type: 'array',
        minItems: insights.maps.length,
        maxItems: insights.maps.length,
        items: {
          anyOf: insights.maps.map((map) => ({
            ...planClaim,
            properties: {
              ...planClaim.properties,
              order: { type: 'integer', const: map.order },
              evidence_ids: {
                ...planClaim.properties.evidence_ids,
                items: {
                  type: 'string',
                  enum: [
                    map.reference,
                    ...map.players.map(
                      (p) => `fact:reader-player:${map.order}:${p.id}`,
                    ),
                  ],
                },
              },
            },
            required: [...planClaim.required, 'order'],
          })),
        },
      },
    },
  };
}
export function validateEditorialPlan(
  plan: EditorialPlan,
  insights: ReaderInsights,
  refs: string[],
) {
  const known = new Set(refs.filter((id) => id.startsWith('fact:')));
  const claimValid = (claim: EditorialPlan['findings'][number]) =>
    typeof claim?.angle === 'string' &&
    claim.angle.trim() &&
    claim.angle.length <= 220 &&
    typeof claim.limit === 'string' &&
    claim.limit.trim() &&
    claim.limit.length <= 180 &&
    Array.isArray(claim.evidence_ids) &&
    claim.evidence_ids.length > 0 &&
    claim.evidence_ids.length <= 8 &&
    claim.evidence_ids.every((id) => known.has(id));
  if (
    !plan ||
    typeof plan.thesis !== 'string' ||
    !plan.thesis.trim() ||
    plan.thesis.length > 180 ||
    !Array.isArray(plan.findings) ||
    plan.findings.length > 3 ||
    !plan.findings.every(claimValid) ||
    !Array.isArray(plan.maps) ||
    plan.maps.length !== insights.maps.length ||
    new Set(plan.maps.map((m) => m.order)).size !== plan.maps.length ||
    plan.maps.some(
      (claim) =>
        !claimValid(claim) ||
        !insights.maps.some(
          (map) =>
            map.order === claim.order &&
            claim.evidence_ids.includes(map.reference) &&
            claim.evidence_ids.every(
              (ref) =>
                ref === map.reference ||
                map.players.some(
                  (p) => ref === `fact:reader-player:${map.order}:${p.id}`,
                ),
            ),
        ),
    )
  )
    throw new Error('schema_editorial_plan_evidence');
  return plan;
}

export const editorialPlanInstruction = `你是无畏契约赛事分析编辑。先做证据提纲，不写战报，不按数据表逐行翻译。
从十名选手的完整分图表现找出本场最有解释力的两三个问题：为何总比分看似悬殊但部分地图胶着？赢家在不同地图是否由不同选手支撑？输家哪项优势真实存在，却不足以概括整图表现？只有输入支持才选，不套题。
thesis给出本场核心判断；findings每条是一个值得向观众解释的具体观察，并附精确证据和该证据不能证明的内容；maps逐图选择不同的分析角度，必须保留全部实际地图，每条evidence_ids必须含该图的reference，涉及选手再完整复制该选手的fact:reader-player引用，禁止缩写ID。angle和limit都是字符串，不能写嵌套对象。缺资料就明确不能判断，不将比分本身当成输赢原因。
优先比较数据之间的关系，而非堆数据：某人占全队击杀的比重、首杀领先与整图表现是否同向、跨图贡献是否由不同人承担。击杀集中度只说明击杀分布，不说明全队资源分配或打法依赖。
相同英雄仅作表现对照，不得当作直接交手；首死总数无法推导失误、被针对或队友没补枪。首杀不能推导该回合是否取胜；总数据不能推导发生在什么阶段。没有攻防、经济、回合和录像，不得编造控图、转点、回防、道具衔接、手枪局或关键回合。
不把队伍获胜归咎于一个人的低数据，不把同一相关关系写成因果。只使用analysis_packet；参考写作方式不是参考其他比赛的事实。输出仅为所要求的JSON提纲。`;

export const editorialArticleInstruction = `把editorial_plan作为待审提纲，以analysis_packet为唯一事实来源，写一篇有明确观点的无畏契约赛后分析。不是润色提纲：先核实观点，不能证明的就删。
summary一句话回答本场最突出的差别。reasons最多2条，讲整场层面且互不重复的判断，至少保留输方有竞争力的部分，不先贴强弱标签再挑数据。
maps保留全部实际地图，每段围绕一个具体问题，用必要的1至2组数据解释判断；不要列双方选手的完整统计行，也不要每图都套“首杀接近但伤害不同”。可以比较角色表现，但不能声称知道实际任务分工。
matchups最多2组，只有补充了地图段落没讲过的观察才写，否则为空。不能把同英雄比较当直接对决，更不能只因为用了同英雄就说谁被谁压制。
每段fact只放必要证据，interpretation回答“这个观察如何改变我们对这张图/这名选手的理解”。不要把fact换词再说一次。不要重复“首杀不等于回合胜利”等免责声明；资料边界由页面统一说明。
正文约600至900字，自然、克制、有具体观点，不用问题式套标题，不堆百分数。总览与地图不重复整组数字，不输出全队每回合伤害相加这种陌生指标。不是已观看录像的战术复盘，不写不存在的回合过程、开局策略、经济链、道具配合、补枪问题、指挥或心理原因。不写“首杀优势未转化为胜利/整体减员效率”这种需要逐回合验证的推断。
只在reader_review里返回正文。fact必须是字符串，与interpretation、evidence_ids同级。图内引用只能是该图reference或该图选手，跨图比较放reasons。matchups的ID和引用完整复制给定候选，不改概率、不诊断权重、不训练。`;
