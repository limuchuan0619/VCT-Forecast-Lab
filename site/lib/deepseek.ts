import type {
  ChallengerPrediction,
  PostmatchAiReview,
  PostmatchModelDiagnosis,
  PredictionSnapshot,
  PrematchAiAnalysis,
} from './vct-types';
import type { AnalysisPacket } from './ai-reliability';
import { normalizeReaderReview } from './reader-analysis';
import { VALORANT_GLOSSARY_INSTRUCTION } from './valorant-terms.ts';
import {
  EDITORIAL_REVIEW_SCHEMA,
  editorialEvidence,
  editorialPlanSchemaFor,
  editorialPlanInstruction,
  editorialArticleInstruction,
  validateEditorialPlan,
} from './review-editorial.ts';
import type { EditorialPlan } from './review-editorial.ts';
import {
  POSTMATCH_JOB_PROMPT_VERSION,
  sha256,
  POSTMATCH_R2_REASONING_EFFORT,
  PREMATCH_JOB_PROMPT_VERSION,
} from './ai-reliability';
import { DIAGNOSIS_JOB_PROMPT_VERSION } from './model-diagnosis';
import type { DiagnosisPacket } from './model-diagnosis';

export const PREMATCH_PROMPT_VERSION = PREMATCH_JOB_PROMPT_VERSION;
export const POSTMATCH_PROMPT_VERSION = 'vct-postmatch-deepseek-v3-r1';
export const MODEL_DIAGNOSIS_PROMPT_VERSION = DIAGNOSIS_JOB_PROMPT_VERSION;

const commonRules = `你是 VCT Forecast Lab 的受限分析层，不是自由发挥的赛事评论员。只能使用输入 JSON 中明确存在的证据，并通过 evidence_id 指向证据；禁止补造 BP、Patch、逐回合战术、阵容、新闻、选手心理或未给出的地图。赛前分析不得使用比赛开始后的信息。赛后必须严格区分 FACT、MODEL SIGNAL 和 HYPOTHESIS；缺失的地图、选手、攻防、BP 数据必须明确写成缺失，绝不能补造。命中、精确比分、Brier、Log Loss、实际结果概率和惊讶度只由系统确定性 scorecard 决定，你不得重新计算或判断概率“是否合理”。数学模型是唯一正式概率源。优化建议只能成为待回测假设，不得直接修改概率、训练、发布或晋级模型。所有地图名使用输入中的中文名称。语言具体、可证伪，避免无证据套话。输出必须符合 JSON Schema。`;

const prematchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stage: { type: 'string', const: 'prematch' },
    ai_probability_team_a: { type: 'number', minimum: 0.02, maximum: 0.98 },
    predicted_score: { type: 'string' },
    summary: { type: 'string' },
    key_factors: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          factor: { type: 'string' },
          direction: { type: 'string', enum: ['team_a', 'team_b', 'neutral'] },
          claim: { type: 'string' },
          importance: { type: 'number', minimum: 0, maximum: 1 },
          evidence_ids: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'factor',
          'direction',
          'importance',
          'evidence_ids',
          'claim',
        ],
      },
    },
    risk_flags: { type: 'array', items: { type: 'string' } },
    upset_conditions: { type: 'array', items: { type: 'string' } },
    model_disagreement: { type: 'string' },
    optimization_hypotheses: { type: 'array', items: { type: 'string' } },
    evidence_grade: { type: 'string', enum: ['high', 'medium', 'low'] },
    official_model_reading: {
      type: 'object',
      additionalProperties: false,
      properties: {
        favored_team: { type: 'string' },
        probability_gap_pp: { type: 'number' },
        strongest_support: { type: 'string' },
        strongest_counterweight: { type: 'string' },
      },
      required: [
        'favored_team',
        'probability_gap_pp',
        'strongest_support',
        'strongest_counterweight',
      ],
    },
    team_a_win_conditions: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
    },
    team_b_win_conditions: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
    },
    map_analysis: {
      type: 'array',
      maxItems: 7,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          map: { type: 'string' },
          team_a_probability: { type: 'number', minimum: 0.02, maximum: 0.98 },
          interpretation: { type: 'string' },
          sample_warning: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'map',
          'team_a_probability',
          'interpretation',
          'sample_warning',
          'evidence_ids',
        ],
      },
    },
    uncertainty: {
      type: 'object',
      additionalProperties: false,
      properties: {
        missing_data: { type: 'array', items: { type: 'string' } },
        low_sample_signals: { type: 'array', items: { type: 'string' } },
        invalidation_triggers: { type: 'array', items: { type: 'string' } },
      },
      required: ['missing_data', 'low_sample_signals', 'invalidation_triggers'],
    },
    structured_hypotheses: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hypothesis: { type: 'string' },
          target_feature: { type: 'string' },
          expected_effect: { type: 'string' },
          validation_plan: { type: 'string' },
        },
        required: [
          'hypothesis',
          'target_feature',
          'expected_effect',
          'validation_plan',
        ],
      },
    },
    direct_promotion_allowed: { type: 'boolean', const: false },
  },
  required: [
    'stage',
    'ai_probability_team_a',
    'predicted_score',
    'summary',
    'key_factors',
    'risk_flags',
    'upset_conditions',
    'model_disagreement',
    'optimization_hypotheses',
    'evidence_grade',
    'official_model_reading',
    'team_a_win_conditions',
    'team_b_win_conditions',
    'map_analysis',
    'uncertainty',
    'structured_hypotheses',
    'direct_promotion_allowed',
  ],
};

const postmatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stage: { type: 'string', const: 'postmatch' },
    summary: { type: 'string' },
    facts: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
        },
        required: ['claim', 'evidence_ids'],
      },
    },
    model_signals: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
        },
        required: ['claim', 'evidence_ids'],
      },
    },
    hypotheses: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hypothesis: { type: 'string' },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['hypothesis', 'evidence_ids', 'confidence'],
      },
    },
    missing_evidence: { type: 'array', items: { type: 'string' } },
    map_review: {
      type: 'array',
      maxItems: 7,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          map: { type: 'string' },
          actual_evidence: { type: 'string' },
          hypothesis: { type: 'string' },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
        },
        required: ['map', 'actual_evidence', 'hypothesis', 'evidence_ids'],
      },
    },
    research_hypotheses: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hypothesis: { type: 'string' },
          target_feature: { type: 'string' },
          validation_plan: { type: 'string' },
          no_direct_change: { type: 'boolean', const: true },
        },
        required: [
          'hypothesis',
          'target_feature',
          'validation_plan',
          'no_direct_change',
        ],
      },
    },
    deterministic_scorecard_owned_by_system: { type: 'boolean', const: true },
    direct_probability_change_allowed: { type: 'boolean', const: false },
    direct_training_allowed: { type: 'boolean', const: false },
    direct_promotion_allowed: { type: 'boolean', const: false },
  },
  required: [
    'stage',
    'summary',
    'facts',
    'model_signals',
    'hypotheses',
    'missing_evidence',
    'map_review',
    'research_hypotheses',
    'deterministic_scorecard_owned_by_system',
    'direct_probability_change_allowed',
    'direct_training_allowed',
    'direct_promotion_allowed',
  ],
};

const r2EvidenceItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claim: { type: 'string' },
    evidence_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string' },
    },
  },
  required: ['claim', 'evidence_ids'],
};

const postmatchR2Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stage: { type: 'string', const: 'postmatch' },
    one_line_summary: { type: 'string' },
    what_happened: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: r2EvidenceItem,
    },
    three_signals: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          signal: { type: 'string' },
          relation: {
            type: 'string',
            enum: ['supported_result', 'contradicted_result', 'neutral'],
          },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: { type: 'string' },
          },
        },
        required: ['signal', 'relation', 'evidence_ids'],
      },
    },
    map_reviews: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          map: { type: 'string' },
          fact: { type: 'string' },
          model_signal: { type: 'string' },
          hypothesis: { type: 'string' },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: { type: 'string' },
          },
        },
        required: ['map', 'fact', 'model_signal', 'hypothesis', 'evidence_ids'],
      },
    },
    player_outliers: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          player: { type: 'string' },
          map: { type: 'string' },
          fact: { type: 'string' },
          hypothesis: { type: 'string' },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: { type: 'string' },
          },
        },
        required: ['player', 'map', 'fact', 'hypothesis', 'evidence_ids'],
      },
    },
    hypotheses: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hypothesis: { type: 'string' },
          tag: {
            type: 'string',
            enum: [
              'rating_lag',
              'recent_form',
              'roster_change',
              'map_matchup',
              'player_form',
              'cross_region',
              'missing_context',
              'calibration',
              'unexplained',
            ],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: { type: 'string' },
          },
        },
        required: ['hypothesis', 'tag', 'confidence', 'evidence_ids'],
      },
    },
    missing_evidence: { type: 'array', items: { type: 'string' } },
    research_queue: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        hypothesis: { type: 'string' },
        tag: { type: 'string' },
        status: { type: 'string', const: 'NEW' },
        evidence_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'string' },
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['hypothesis', 'tag', 'status', 'evidence_ids', 'confidence'],
    },
    direct_probability_change_allowed: { type: 'boolean', const: false },
    direct_training_allowed: { type: 'boolean', const: false },
    direct_promotion_allowed: { type: 'boolean', const: false },
  },
  required: [
    'stage',
    'one_line_summary',
    'what_happened',
    'three_signals',
    'map_reviews',
    'player_outliers',
    'hypotheses',
    'missing_evidence',
    'research_queue',
    'direct_probability_change_allowed',
    'direct_training_allowed',
    'direct_promotion_allowed',
  ],
};

const teamReviewSchema = {
  ...postmatchR2Schema,
  properties: {
    ...postmatchR2Schema.properties,
    team_reviews: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team: { type: 'string' },
          outcome: { type: 'string', enum: ['won', 'lost'] },
          strengths: {
            type: 'array',
            maxItems: 2,
            items: {
              ...r2EvidenceItem,
              properties: {
                ...r2EvidenceItem.properties,
                claim: { type: 'string', minLength: 1, maxLength: 180 },
              },
            },
          },
          weaknesses: {
            type: 'array',
            maxItems: 2,
            items: {
              ...r2EvidenceItem,
              properties: {
                ...r2EvidenceItem.properties,
                claim: { type: 'string', minLength: 1, maxLength: 180 },
              },
            },
          },
          possible_explanation: {
            ...r2EvidenceItem,
            type: ['object', 'null'],
            properties: {
              ...r2EvidenceItem.properties,
              claim: { type: 'string', minLength: 1, maxLength: 180 },
            },
          },
        },
        required: [
          'team',
          'outcome',
          'strengths',
          'weaknesses',
          'possible_explanation',
        ],
      },
    },
  },
  required: [...postmatchR2Schema.required, 'team_reviews'],
};

const readerClaimSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fact: { type: 'string', minLength: 1, maxLength: 240 },
    interpretation: { type: 'string', maxLength: 240 },
    evidence_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string' },
    },
  },
  required: ['fact', 'interpretation', 'evidence_ids'],
};
const readerReviewSchema = {
  ...teamReviewSchema,
  properties: {
    ...teamReviewSchema.properties,
    reader_review: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 180 },
        reasons: {
          type: 'array',
          maxItems: 3,
          items: {
            ...readerClaimSchema,
            properties: {
              ...readerClaimSchema.properties,
              title: { type: 'string', minLength: 1, maxLength: 60 },
            },
            required: [...readerClaimSchema.required],
          },
        },
        maps: {
          type: 'array',
          maxItems: 5,
          items: {
            ...readerClaimSchema,
            properties: {
              ...readerClaimSchema.properties,
              order: { type: 'integer', minimum: 1, maximum: 5 },
              map: { type: 'string' },
            },
            required: [...readerClaimSchema.required, 'order', 'map'],
          },
        },
        matchups: {
          type: 'array',
          maxItems: 2,
          items: {
            ...readerClaimSchema,
            properties: {
              ...readerClaimSchema.properties,
              mapOrder: { type: 'integer' },
              agent: { type: 'string' },
              playerAId: { type: 'string' },
              playerBId: { type: 'string' },
            },
            required: [
              ...readerClaimSchema.required,
              'mapOrder',
              'agent',
              'playerAId',
              'playerBId',
            ],
          },
        },
      },
      required: ['summary', 'reasons', 'maps', 'matchups'],
    },
  },
  required: [...teamReviewSchema.required, 'reader_review'],
};

const readerInstruction =
  '为普通VALORANT观众写一篇能直接读懂的复盘。先看analysis_packet.readerInsights：这是从本场完整分图统计核验出的队伍归属、首杀和同特工表现，不是录像战术分析。reader_review.summary用一句话点明最重要的表现差别；reasons最多2至3条，先说事实再解释其比赛意义，出现反例也要说明；证据不足可为空，不能只把比分当原因。maps按实际order逐张写，每张选一个重点，不复述总览；没有选手资料就明确仅知道地图结果。matchups最多2个且只能使用readerInsights.positions给定的mapOrder/agent/playerAId/playerBId，引用对应两位选手的fact:reader-player证据；不够就为空。这是相同特工位置的表现比较，不是两人直接交火的胜负。不要将总击杀、首杀、首死、每回合伤害混为一谈；相同伤害不得写成伤害碾压；缺少个人历史基线不得写超常发挥或状态下滑。fact只写可核实数据，interpretation说明这些表现可能意味着什么，不能将统计关联写成已确认因果；没有回合、经济、站位资料不得写被针对、指挥失误、战术压制、关键回合或心理原因。接近五五开的预测不强行归咎于模型失误。全部使用简洁自然中文，不向读者输出factor键、评分小数、英文计算术语。每条引用必须精确，图内引用不得跨图。避免反复免责声明，同一数据不要在三处完整重复。旧兼容字段保持最简，reader_review为主要阅读内容，总量约800至1200字。禁止猜测选手归属、不得修改概率或训练晋级。';

const comparisonReviewInstruction = `${readerInstruction}
本版不是数据播报，而是比赛评论。先阅读所有地图的十名选手，再决定观点，不要被playerOutliers的四条筛选结果带偏。
写作方法：比较→指出矛盾或差异→解释它对本场胜负的含义→交代这一解释不能说明什么。标题必须是具体观点，不用“谁提供了输出”“先看开局先手”等泛用问句。
summary给出一个具体、直白、有本场辨识度的总判断，不要只报胜者与比分。reasons选2–3个不同的表现差异；至少一条应检验反例或输方仍有竞争力的部分，不能把所有地图写成赢家全程碾压。不要把赢下几图当成获胜原因，不要把首杀总数直接当作进攻/防守成功率。
每张maps先写与其他图不同的观察，再解释，例如：首杀接近但伤害或击杀差异很大；某位选手输出突出但仍输图；同样位置中伤害与开局贡献方向相反。只选择数据确实存在的对照，不套用例子。每段只留支撑观点的2–4个数字，不列两队各两人的整行统计。
positions现在是候选集合，不是必须逐条播报的结论。matchups从中挑最多2个对胜负解释最有帮助的比较，不能机械挑首杀净差最大的两组。选择一名选手表现强仍未赢图的反例也可以。比较同特工的任务相关表现：造成伤害、减少对手人数和首个减员风险，不假装知道具体职责分工或直接单挑结果。没有可解释差异就省略。
fact只给必要证据，interpretation必须有实际比较和含义，不能把fact换词再说一遍；不要用“结合下面的数据”“值得关注”“执行力更好”“首杀不等于回合胜利”等套话充数。读者应能回答：这张地图与别图到底不同在哪，哪位选手在哪方面占优，又在哪方面并未占优。
解释的深度来自指标之间的反差，不来自编造过程。例如一名选手首杀更多但整图伤害更少、阵亡更多，只能说他在开局减员上领先，而非整图表现全面领先；不能据此推测后面的回合发生了什么。整图统计不能定位中后期、回合控制、控图、关键回合、战术压制、残局或首杀转化率，这些词不要出现在文章里。不要说伤害会转化为首死；伤害、击杀、首死是不同统计，不存在这样的换算。不要空泛地说输出更均衡、比赛更高强度、节奏更好或支援更稳定，除非输入直接提供对应证据。正文写“每回合伤害”，不要用ADR缩写。特工中文名如neon=霓虹、chamber=钱博尔、omen=幽影；仅用于正文，结构化agent字段保留输入的原始英文ID。
正文不写“导致”“驱动”“决定胜负”等已确认因果，而是具体指出差距在哪、哪项优势并未伴随胜利。不要反复免责声明。完整评论放reader_review；不评价模型权重对错，不把赛前五五开说成确定看好。每个条目的fact必须是字符串，interpretation和evidence_ids与fact同级，不能嵌套进fact对象。
输出前逐句核对：某个选手伤害高不等于全队伤害高；全队比较看teamMapTotals，不能挑两人代表五人。不能说某队通常伤害更高，除非多张图的全队合计确实如此。deaths是总阵亡，firstDeaths才是首死，绝对不能互换，任一队整张图的首死都不可能超过rounds。需要首杀/首死数时直接读firstKills/firstDeaths，不要自己猜或从总阵亡代替。不要把“首杀12比9”叫作“开场12比9”：它是整图累计首杀，不是地图开局比分。首杀、首死均为整图累计，不能编成比赛早期或比分领先过程。一个位置表现较弱不等于输图责任已经被证明，不把个体低数据写成输因定论。少讲几条也比堆砌错误归因好；summary只保留能够在输入中直接核实的比赛特点。不要编写反扑、反超、追分或直到最后才赢等比赛走势。总览reasons最多两条，每条仅用最必要的一两个数字，不与地图段落重复整组统计。
阅读优先：teamMapTotals只供核对，不要把全队每回合伤害合计、击杀合计连续播报给读者。正文以具体选手与表现差异为主，每段围绕一个观察，只保留一到两类关键指标，不能把双方的击杀、死亡、伤害、首杀、首死全抄一遍。每个fact加interpretation合计尽量不超过120个汉字。总览讲跨地图的格局；分图讲一处有解释价值的差别；同位置比较选择一种矛盾或反差，不做数据汇总。检查“更多/更少”到底与谁比，不能把领先的一方写成拿到更少先手。检查叙述是否只把数字换词重复；解释必须回答“这个差别与单看击杀或总比分有什么不同”。`;

const diagnosisTags = [
  'rating_lag',
  'recent_form',
  'roster_change',
  'map_matchup',
  'player_form',
  'cross_region',
  'missing_context',
  'calibration',
  'unexplained',
];
const evidenceClaim = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claim: { type: 'string' },
    evidence_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
  },
  required: ['claim', 'evidence_ids'],
};
const modelDiagnosisSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stage: { type: 'string', const: 'postmatch_model_diagnosis' },
    prediction_summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        champion_probability_team_a: { type: 'number', minimum: 0, maximum: 1 },
        c1_probability_team_a: { type: 'number', minimum: 0, maximum: 1 },
        actual_winner: { type: 'string' },
      },
      required: [
        'champion_probability_team_a',
        'c1_probability_team_a',
        'actual_winner',
      ],
    },
    model_agreement: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['models_agreed', 'models_disagreed'] },
        probability_gap: { type: 'number' },
      },
      required: ['status', 'probability_gap'],
    },
    facts: { type: 'array', maxItems: 8, items: evidenceClaim },
    model_signals: { type: 'array', maxItems: 8, items: evidenceClaim },
    hypotheses: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hypothesis: { type: 'string' },
          tag: { type: 'string', enum: diagnosisTags },
          evidence_ids: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['hypothesis', 'tag', 'evidence_ids', 'confidence'],
      },
    },
    diagnostic_tags: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', enum: diagnosisTags },
    },
    research_hypothesis: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    direct_probability_change_allowed: { type: 'boolean', const: false },
    direct_training_allowed: { type: 'boolean', const: false },
    direct_promotion_allowed: { type: 'boolean', const: false },
  },
  required: [
    'stage',
    'prediction_summary',
    'model_agreement',
    'facts',
    'model_signals',
    'hypotheses',
    'diagnostic_tags',
    'research_hypothesis',
    'confidence',
    'direct_probability_change_allowed',
    'direct_training_allowed',
    'direct_promotion_allowed',
  ],
};

function outputText(payload: unknown): string {
  const record = payload as {
    output_text?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string } | null;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  if (record.output_text) return record.output_text;
  for (const item of record.output ?? [])
    for (const part of item.content ?? [])
      if (part.type === 'output_text' && part.text) return part.text;
  if (record.status === 'incomplete')
    throw new Error(
      `deepseek_incomplete_${record.incomplete_details?.reason || 'unknown'}`,
    );
  if (record.status === 'failed')
    throw new Error(
      `deepseek_response_failed_${record.error?.code || 'unknown'}`,
    );
  throw new Error('deepseek_empty_output');
}

export type DeepSeekRequestMeta = {
  requestStartedAt: string;
  requestCompletedAt: string;
  latencyMs: number;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  payloadBytes: number;
};

export class DeepSeekRequestError extends Error {
  code: string;
  stage: string;
  httpStatus: number | null;
  retryable: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  payloadBytes: number;
  constructor(
    message: string,
    metadata: {
      code: string;
      stage: string;
      httpStatus?: number | null;
      retryable?: boolean;
      inputTokens?: number | null;
      outputTokens?: number | null;
      payloadBytes: number;
    },
  ) {
    super(message);
    this.name = 'DeepSeekRequestError';
    this.code = metadata.code;
    this.stage = metadata.stage;
    this.httpStatus = metadata.httpStatus ?? null;
    this.retryable = Boolean(metadata.retryable);
    this.inputTokens = metadata.inputTokens ?? null;
    this.outputTokens = metadata.outputTokens ?? null;
    this.payloadBytes = metadata.payloadBytes;
  }
}

async function requestJson<T>(options: {
  apiKey: string;
  modelId: string;
  promptVersion: string;
  schemaName: string;
  schema: object;
  input: object;
  maxOutputTokens?: number;
  timeoutMs?: number;
  reasoningEffort?:
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max';
}): Promise<{
  output: T;
  modelId: string;
  promptVersion: string;
  meta: DeepSeekRequestMeta;
}> {
  const requestBody = JSON.stringify({
    model: options.modelId,
    instructions: commonRules,
    input: JSON.stringify(options.input),
    reasoning: { effort: options.reasoningEffort ?? 'high' },
    max_output_tokens: options.maxOutputTokens ?? 6000,
    text: {
      format: {
        type: 'json_schema',
        name: options.schemaName,
        schema: options.schema,
      },
    },
  });
  const payloadBytes = new TextEncoder().encode(requestBody).byteLength;
  const requestStartedAt = new Date().toISOString();
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 55_000,
  );
  try {
    let response: Response;
    try {
      response = await fetch('https://api.deepseek.com/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new DeepSeekRequestError(
        aborted
          ? 'deepseek_timeout'
          : `deepseek_connection_${error instanceof Error ? error.message : 'unknown'}`,
        {
          code: aborted ? 'deepseek_timeout' : 'deepseek_connection_error',
          stage: 'transport',
          retryable: true,
          payloadBytes,
        },
      );
    }
    const responseText = await response.text();
    if (!response.ok)
      throw new DeepSeekRequestError(`deepseek_http_${response.status}`, {
        code: `deepseek_http_${response.status}`,
        stage: 'provider',
        httpStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
        payloadBytes,
      });
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new DeepSeekRequestError('deepseek_response_invalid_json', {
        code: 'deepseek_response_invalid_json',
        stage: 'parse',
        httpStatus: response.status,
        payloadBytes,
      });
    }
    const usage = (
      payload as { usage?: { input_tokens?: number; output_tokens?: number } }
    ).usage;
    let textOutput: string;
    try {
      textOutput = outputText(payload);
    } catch (error) {
      const code =
        error instanceof Error ? error.message : 'deepseek_empty_output';
      throw new DeepSeekRequestError(code, {
        code,
        stage: code.includes('max_output') ? 'payload' : 'provider',
        httpStatus: response.status,
        payloadBytes,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
      });
    }
    let parsed: T;
    try {
      parsed = JSON.parse(textOutput) as T;
    } catch (error) {
      throw new DeepSeekRequestError(
        `deepseek_output_invalid_json:${error instanceof Error ? error.message : 'parse_error'}`,
        {
          code: 'deepseek_output_invalid_json',
          stage: 'parse',
          httpStatus: response.status,
          payloadBytes,
          inputTokens: usage?.input_tokens ?? null,
          outputTokens: usage?.output_tokens ?? null,
        },
      );
    }
    const requestCompletedAt = new Date().toISOString();
    return {
      output: parsed,
      modelId: options.modelId,
      promptVersion: options.promptVersion,
      meta: {
        requestStartedAt,
        requestCompletedAt,
        latencyMs: Date.now() - started,
        httpStatus: response.status,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        payloadBytes,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function prematchInput(prediction: PredictionSnapshot) {
  return {
    stage: 'prematch',
    prediction_id: prediction.id,
    locked_at: prediction.lockedAt,
    scheduled_at: prediction.scheduledAt,
    data_cutoff_at: prediction.dataCutoffAt,
    event: prediction.event,
    region: prediction.region,
    patch: prediction.patch,
    series_format: prediction.seriesFormat,
    teams: { team_a: prediction.teamA, team_b: prediction.teamB },
    official_math_probability_team_a: prediction.teamAProbability,
    official_predicted_score: prediction.predictedScore,
    factor_contributions: prediction.factors.map((factor) => ({
      evidence_id: `factor:${factor.key}`,
      ...factor,
    })),
    map_probabilities: prediction.maps.map((map) => ({
      evidence_id: `map:${map.map}`,
      ...map,
    })),
    score_distribution: prediction.scoreDistribution,
    evidence_boundary: prediction.evidence,
    reader_guidance:
      '用普通中文解释两三个主要理由、反向信息与地图判断。评分不是具体战绩：输入没有近期对手、连胜、官方首发或真实版本时不得补写这些故事。仅有模型分数时说明这是赛前评估，不把它写成已确认的比赛事实；不输出内部英文键和评分小数。候选地图不是实际BP，结合保存的胜率和样本提示，不作确定承诺。',
  };
}

export function analyzePrematch(
  apiKey: string,
  modelId: string,
  prediction: PredictionSnapshot,
  saved?: { packet: object; promptVersion: string },
) {
  return requestJson<PrematchAiAnalysis>({
    apiKey,
    modelId,
    promptVersion: saved?.promptVersion ?? PREMATCH_PROMPT_VERSION,
    schemaName: 'vct_prematch_analysis',
    schema: prematchSchema,
    input: saved?.packet ?? prematchInput(prediction),
    reasoningEffort: 'none',
    maxOutputTokens: 3_600,
    timeoutMs: 55_000,
  });
}

export function analyzePostmatch(
  apiKey: string,
  modelId: string,
  prediction: PredictionSnapshot,
) {
  return requestJson<PostmatchAiReview>({
    apiKey,
    modelId,
    promptVersion: POSTMATCH_PROMPT_VERSION,
    schemaName: 'vct_postmatch_review',
    schema: postmatchSchema,
    input: {
      ...prematchInput(prediction),
      stage: 'postmatch',
      analysis_boundary: {
        deterministic_scorecard_owned_by_system: true,
        ai_must_not_recompute_correctness_or_probability_metrics: true,
        fact_model_signal_hypothesis_separation_required: true,
      },
      deterministic_scorecard: {
        evidence_id: 'system:scorecard',
        ...prediction.scorecard,
      },
      result_evidence: {
        evidence_id: 'fact:result_evidence',
        ...prediction.resultEvidence,
      },
      actual_winner: prediction.actualWinner,
      actual_score: prediction.actualScore,
      resolved_at: prediction.resolvedAt,
    },
  });
}

export async function analyzePostmatchR2(
  apiKey: string,
  modelId: string,
  prediction: PredictionSnapshot,
  packet: AnalysisPacket,
  versions?: {
    promptVersion: string;
    schemaVersion: string;
    attemptCount?: number;
  },
) {
  const teamReview = packet.reviewFocus === 'team_outcomes_v1';
  const reader = Boolean(packet.readerInsights);
  const editorial = versions?.schemaVersion === EDITORIAL_REVIEW_SCHEMA;
  const articleOnly =
    packet.readerInsights?.analysisStyle === 'comparison_v2' &&
    (!versions ||
      versions.schemaVersion === 'v1.4c-reader2-postmatch-analysis-v11' ||
      editorial);
  if (articleOnly) {
    const requestOptions: Parameters<typeof requestJson>[0] = {
      apiKey,
      modelId,
      promptVersion: versions?.promptVersion ?? POSTMATCH_JOB_PROMPT_VERSION,
      schemaName: 'vct_postmatch_reader_article_v2',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reader_review: {
            ...readerReviewSchema.properties.reader_review,
            properties: {
              ...readerReviewSchema.properties.reader_review.properties,
              maps: {
                type: 'array',
                minItems: packet.readerInsights!.maps.length,
                maxItems: packet.readerInsights!.maps.length,
                items: {
                  anyOf: packet.readerInsights!.maps.map((map) => ({
                    ...readerReviewSchema.properties.reader_review.properties
                      .maps.items,
                    properties: {
                      ...readerReviewSchema.properties.reader_review.properties
                        .maps.items.properties,
                      order: { type: 'integer', const: map.order },
                      map: { type: 'string', const: map.map },
                      evidence_ids: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 8,
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
                  })),
                },
              },
              matchups: {
                ...readerReviewSchema.properties.reader_review.properties
                  .matchups,
                maxItems: Math.min(2, packet.readerInsights!.positions.length),
                ...(packet.readerInsights!.positions.length
                  ? {
                      items: {
                        anyOf: packet.readerInsights!.positions.map((pair) => ({
                          ...readerReviewSchema.properties.reader_review
                            .properties.matchups.items,
                          properties: {
                            ...readerReviewSchema.properties.reader_review
                              .properties.matchups.items.properties,
                            mapOrder: { type: 'integer', const: pair.mapOrder },
                            agent: { type: 'string', const: pair.agent },
                            playerAId: { type: 'string', const: pair.a.id },
                            playerBId: { type: 'string', const: pair.b.id },
                            evidence_ids: {
                              type: 'array',
                              minItems: 3,
                              maxItems: 3,
                              uniqueItems: true,
                              items: { type: 'string', enum: pair.references },
                            },
                          },
                        })),
                      },
                    }
                  : {}),
              },
            },
          },
        },
        required: ['reader_review'],
      },
      maxOutputTokens: editorial ? 6000 : 4500,
      // Two bounded calls per article: 2 x 35s x 3 jobs < Runner's 240s.
      timeoutMs: editorial ? 45_000 : 35_000,
      reasoningEffort: editorial ? 'low' : 'none',
      input: {
        stage: 'postmatch',
        instruction:
          comparisonReviewInstruction +
          '\n' +
          VALORANT_GLOSSARY_INSTRUCTION +
          '\n本次只返回reader_review，不生成旧兼容栏目、模型权重诊断或研究假设。引用逐字从evidenceReferences复制，不缩写ID。每个maps条目必须引用该图reference，不能引用另一张地图；跨图比较放reasons。matchups的evidence_ids必须完整复制对应pair.references。',
        // Match commentary does not need model-factor scores or diagnostic
        // ledgers. Keep the reader focused on the verified match itself.
        analysis_packet: {
          teams: { a: prediction.teamA, b: prediction.teamB },
          result: {
            winner: prediction.actualWinner,
            score: prediction.actualScore,
          },
          readerInsights: packet.readerInsights,
          // Transparent arithmetic over the same verified map rows. Not a
          // model feature or historical baseline. Null never becomes zero.
          teamMapTotals: (editorial ? [] : packet.readerInsights!.maps).flatMap(
            (map) =>
              [prediction.teamA, prediction.teamB].map((team) => {
                const players = map.players.filter((p) => p.team === team);
                const sum = (
                  key:
                    | 'kills'
                    | 'deaths'
                    | 'adr'
                    | 'firstKills'
                    | 'firstDeaths',
                ) =>
                  players.length === 5 && players.every((p) => p[key] !== null)
                    ? players.reduce((n, p) => n + p[key]!, 0)
                    : null;
                return {
                  mapOrder: map.order,
                  map: map.map,
                  team,
                  kills: sum('kills'),
                  deaths: sum('deaths'),
                  rounds: map.score
                    .split(':')
                    .map(Number)
                    .reduce((a, b) => a + b, 0),
                  firstKills: sum('firstKills'),
                  firstDeaths: sum('firstDeaths'),
                  combinedDamagePerRound: sum('adr'),
                  reference: map.reference,
                };
              }),
          ),
          evidenceReferences: packet.evidenceReferences.filter((id) =>
            id.startsWith('fact:'),
          ),
          missingEvidence: packet.missingEvidence,
          ...(editorial
            ? {
                descriptiveReviewBrief: editorialEvidence(
                  packet.readerInsights!,
                  [prediction.teamA, prediction.teamB],
                ),
              }
            : {}),
        },
      },
    };
    type ArticleOutput = {
      reader_review: import('./reader-analysis').ReaderReview;
    };
    const draft = editorial
      ? await requestJson<EditorialPlan>({
          ...requestOptions,
          schemaName: 'vct_postmatch_editorial_plan_v1',
          schema: editorialPlanSchemaFor(
            packet.readerInsights!,
            packet.evidenceReferences,
          ),
          maxOutputTokens: 6000,
          input: {
            ...requestOptions.input,
            instruction:
              editorialPlanInstruction + '\n' + VALORANT_GLOSSARY_INSTRUCTION,
          },
        })
      : await requestJson<ArticleOutput>(requestOptions);
    let normalizedDraft:
      | EditorialPlan
      | import('./reader-analysis').ReaderReview;
    try {
      normalizedDraft = editorial
        ? validateEditorialPlan(
            draft.output as EditorialPlan,
            packet.readerInsights!,
            packet.evidenceReferences,
          )
        : normalizeReaderReview((draft.output as ArticleOutput).reader_review);
    } catch (error) {
      // Raw rejected plans are returned only by the authenticated diagnostics
      // route. They never become public articles or successful analysis rows.
      throw Object.assign(
        error instanceof Error
          ? error
          : new Error('schema_editorial_plan_evidence'),
        {
          rejectedOutput: draft.output,
          code: 'schema_editorial_plan_evidence',
          stage: 'schema',
          retryable: false,
          ...draft.meta,
        },
      );
    }
    const response = await requestJson<ArticleOutput>({
      ...requestOptions,
      schemaName: 'vct_postmatch_evidence_edited_article_v1',
      maxOutputTokens: editorial ? 6000 : 3500,
      input: {
        ...requestOptions.input,
        ...(editorial
          ? { editorial_plan: normalizedDraft }
          : { draft: normalizedDraft }),
        instruction: editorial
          ? editorialArticleInstruction + '\n' + VALORANT_GLOSSARY_INSTRUCTION
          : '你是本场复盘的事实编辑。draft不是事实来源，必须用analysis_packet逐句核对并重写为reader_review。只保留能由给定统计直接支持的观察，不照抄草稿。删除比赛走势、战术过程、心理、地图熟练程度和输因定论；禁止出现中后期、中后段、前压、推进空间、定位阶段、枪械、回合效率、更擅长等没有证据的说法，即使否定句也不要用。检查首杀/首死与总击杀/总阵亡是否混淆，检查更多/更少方向是否正确，检查两倍/三倍是否算对。不要列全队伤害合计，给普通观众只留下重要选手的具体差异。summary一句话概括；reasons最多2条；maps保留全部实际地图；matchups至多2组且必须与positions的两位选手和引用完全一致。每段只讲一个反差，选一到两类指标支撑，然后用自然中文说明它与单看击杀或总比分有什么不同；没有证据就少讲，不用空话填充。每个fact是字符串，interpretation和evidence_ids与fact同级。完整总量约400到600字。保留原JSON结构和精确引用ID，不生成模型诊断。',
      },
    });
    const article = normalizeReaderReview(response.output.reader_review);
    // The existing ledger shape is retained, but compatibility fields contain
    // only deterministic facts or empty lists, never invented AI diagnoses.
    return {
      ...response,
      meta: {
        ...response.meta,
        requestStartedAt: draft.meta.requestStartedAt,
        latencyMs:
          Date.parse(response.meta.requestCompletedAt) -
          Date.parse(draft.meta.requestStartedAt),
        inputTokens:
          draft.meta.inputTokens === null || response.meta.inputTokens === null
            ? null
            : draft.meta.inputTokens + response.meta.inputTokens,
        outputTokens:
          draft.meta.outputTokens === null ||
          response.meta.outputTokens === null
            ? null
            : draft.meta.outputTokens + response.meta.outputTokens,
        payloadBytes: draft.meta.payloadBytes + response.meta.payloadBytes,
      },
      output: {
        stage: 'postmatch',
        one_line_summary: article?.summary,
        what_happened: [
          {
            claim: `${prediction.actualWinner} 获胜，比分按 ${prediction.teamA}:${prediction.teamB} 为 ${prediction.actualScore}。`,
            evidence_ids: ['fact:result_evidence'],
          },
        ],
        three_signals: [
          {
            signal: '赛前预测保持原记录；本篇只解读比赛表现。',
            relation: 'neutral',
            evidence_ids: ['prediction:locked_snapshot'],
          },
        ],
        map_reviews: [],
        player_outliers: [],
        hypotheses: [],
        missing_evidence: packet.missingEvidence,
        research_queue: null,
        direct_probability_change_allowed: false,
        direct_training_allowed: false,
        direct_promotion_allowed: false,
        team_reviews: packet.teamOutcomes!.map((t) => ({
          team: t.team,
          outcome: t.outcome,
          strengths: [],
          weaknesses: [],
          possible_explanation: null,
        })),
        reader_review: article,
        reader_generation_mode: editorial
          ? 'evidence_plan_then_article'
          : 'draft_then_evidence_edit',
        reader_draft_hash: await sha256(normalizedDraft),
        ...(editorial ? { reader_editorial_plan: normalizedDraft } : {}),
        reader_provider_requests: [draft.meta, response.meta],
      },
    };
  }
  return requestJson<Record<string, unknown>>({
    apiKey,
    modelId,
    promptVersion:
      versions?.promptVersion ??
      (teamReview
        ? POSTMATCH_JOB_PROMPT_VERSION
        : 'vct-postmatch-deepseek-v4-r2.1'),
    schemaName: reader
      ? 'vct_postmatch_reader_review_v1'
      : teamReview
        ? 'vct_postmatch_team_review_v1'
        : 'vct_postmatch_analysis_r2',
    schema: reader
      ? readerReviewSchema
      : teamReview
        ? teamReviewSchema
        : postmatchR2Schema,
    maxOutputTokens: reader ? 6_000 : teamReview ? 4_200 : 2_800,
    timeoutMs: 55_000,
    reasoningEffort: POSTMATCH_R2_REASONING_EFFORT,
    input: {
      stage: 'postmatch',
      instruction: reader
        ? packet.readerInsights?.analysisStyle === 'comparison_v2'
          ? comparisonReviewInstruction
          : readerInstruction
        : teamReview
          ? '先解释两队本场赢在哪里、输在哪里，模型为什么偏只是第二层。team_reviews 必须各含两队一次，outcome 与真实赛果一致；strengths/weaknesses 各最多两条、每条180字以内，只描述有 fact: 引用支持的地图得失或本场表现。赢家也可能有短板，输家也可能有亮点；证据不够时使用空数组，不能把比分编成战术原因。每队 possible_explanation 最多一个有 fact: 引用支持的可能解释，明确写可能/尚待验证，只谈该队比赛表现而不是模型；不能解释就填null。这是HYPOTHESIS，不是FACT。仅有 teamId 不代表已知队名，禁止猜测选手归属；没有个人赛前基线，不能写超常发挥/状态下滑。what_happened 是 FACT，three_signals 是 MODEL SIGNAL；map_reviews 对照实际地图与冻结的赛前概率，不把候选图冒充赛前BP。模型偏差的推测原因只放在 hypotheses，写可能/尚待验证，最多3条。不要仅重复胜者和比分，不使用泛泛的执行力/心理/关键回合套话；有证据时给出具体地图、比分、选手数值。全部内容简洁、总量尽量少于800字。不重算指标，不从单场结果证明因素权重正确或错误。只解释 analysis_packet。'
          : '只解释 analysis_packet。what_happened 是 FACT；three_signals 是 MODEL SIGNAL；所有原因说明必须放在 hypothesis 字段。不得重复计算正式指标。',
      analysis_packet: packet,
    },
  });
}

export function analyzePostmatchModelDiagnosis(
  apiKey: string,
  modelId: string,
  packet: DiagnosisPacket,
) {
  return requestJson<PostmatchModelDiagnosis>({
    apiKey,
    modelId,
    promptVersion: MODEL_DIAGNOSIS_PROMPT_VERSION,
    schemaName: 'vct_postmatch_model_diagnosis',
    schema: modelDiagnosisSchema,
    input: packet.input,
    reasoningEffort: 'none',
    maxOutputTokens: 3_600,
    timeoutMs: 55_000,
  });
}

export function deepSeekModel(env: Cloudflare.Env): string {
  return env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
}
