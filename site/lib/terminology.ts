type Term = { label: string; definition: string };

const terms: Record<string, Record<string, Term>> = {
  automation: {
    healthy: { label: '同步正常', definition: '最近一次公开同步完整成功，且仍在预期运行间隔内。' },
    stale: { label: '同步延迟', definition: '最后一次完整成功已经超过预期运行间隔。' },
    degraded: { label: '部分同步失败', definition: '最近一次同步有成功项目，也有失败项目；失败行会在后续批次重试。' },
    failed: { label: '同步失败', definition: '最近一次同步没有完成任何有效项目，不能显示为正常。' },
    waiting: { label: '等待同步', definition: '尚无已完成的公开同步批次，或当前批次仍在运行。' },
  },
  dataMode: {
    LIVE: { label: '已同步的真实记录', definition: '页面内容来自当前线上数据库，并非逐秒更新。' },
    DEGRADED: { label: '实时数据暂不可用', definition: '实时数据读取失败，页面明确展示非实时占位内容。' },
    DEMO: { label: '演示数据', definition: '仅用于界面演示，不代表当前真实预测。' },
  },
  qualityGate: {
    ready: { label: '数据已满足预测要求', definition: '赛程与核心输入在开赛前满足正式预测要求。' },
    locked: { label: '赛前预测已保存', definition: '预测已在开赛前冻结，之后不可改写。' },
    historical_human_archive: { label: '历史人工档案', definition: '旧人工记录，不属于系统模型输出。' },
  },
  classification: {
    normal_variance: { label: '可能属于正常波动', definition: '旧版 AI 的解释标签，不是统计因果结论。' },
    calibration_issue: { label: '可能涉及概率校准', definition: '旧版 AI 的研究假设，不会直接修改模型。' },
    data_issue: { label: '可能涉及数据缺口', definition: '旧版 AI 的研究假设，需用结构化证据验证。' },
    candidate_model_issue: { label: '可能涉及模型表达不足', definition: '旧版 AI 的研究假设，不代表已确认模型错误。' },
  },
  variance: {
    variance: { label: '波动假设', definition: 'AI 辅助解释，不是已确认原因。' },
    model_error: { label: '模型误差假设', definition: 'AI 辅助解释，需要独立样本验证。' },
    mixed: { label: '混合原因假设', definition: 'AI 推测可能同时存在随机波动与模型表达不足。' },
    insufficient_evidence: { label: '证据不足', definition: '现有结构化数据不足以支持原因判断。' },
  },
  aiStatus: {
    complete: { label: '分析完成', definition: 'DeepSeek 已生成受证据边界约束的解释。' },
    failed: { label: '分析失败', definition: 'AI 分析失败，但不影响赛果结算与数学评分。' },
    skipped: { label: '已跳过', definition: 'AI 分析未执行；正式模型和结算仍然有效。' },
    waiting: { label: '等待生成', definition: '尚未生成 AI 分析。' },
    PENDING: { label: '等待分析', definition: '已建立唯一分析作业，等待云端执行。' },
    RUNNING: { label: '分析中', definition: 'DeepSeek 请求正在运行，赛果结算不受影响。' },
    RETRYABLE_FAILED: { label: '暂未成功，将自动重试', definition: '遇到临时供应商或网络故障，正在安排重试。' },
    RETRY_SCHEDULED: { label: '已安排重试', definition: '临时故障已记录，将按版本化退避策略自动重试。' },
    SUCCESS: { label: '分析完成', definition: '受证据边界约束的结构化分析已保存。' },
    FINAL_FAILED: { label: '未能完成，需要检查', definition: '确定性格式、载荷或配置问题已停止自动重试，需要工程处理；正式结算仍有效。' },
  },
  evidenceGrade: {
    high: { label: '高证据等级', definition: '关键结论有多项结构化赛前证据支持。' },
    medium: { label: '中等证据等级', definition: '部分结论有结构化证据，但仍存在关键缺失项。' },
    low: { label: '低证据等级', definition: '可用结构化证据有限，解释应谨慎使用。' },
    A: { label: '证据 A 级', definition: '系列、地图、选手、BP 与阵容证据均可用。' },
    B: { label: '证据 B 级', definition: '系列、地图、选手与实际阵容可用，但 BP 或部分赛前边界仍缺失。' },
    C: { label: '证据 C 级', definition: '系列与地图可用，选手或阵容证据不完整。' },
    D: { label: '证据 D 级', definition: '仅系列结果可靠，解释必须保持非常克制。' },
  },
  challengerPhase: {
    ACCUMULATING: { label: '积累样本', definition: '已结算真实赛前样本少于 30 场。' },
    PRELIMINARY: { label: '初步观察', definition: '已结算真实赛前样本为 30–49 场，不能做晋级结论。' },
    EVALUATING: { label: '持续评估', definition: '已结算真实赛前样本为 50–99 场，仍不能晋级。' },
    GATE_READY: { label: '达到评估门槛', definition: '已达到 100 场样本门槛，仅表示可以开始正式治理评估。' },
  },
  surprise: {
    low: { label: '结果符合看好方向', definition: '模型给实际胜者的赛前概率至少为50%，不代表胜负是确定的。' },
    moderate: { label: '结果偏离看好方向', definition: '模型给实际胜者的赛前概率为30%–50%。' },
    high: { label: '出现较大意外', definition: '模型给实际胜者的赛前概率为10%–30%。' },
    very_high: { label: '出现明显意外', definition: '模型给实际胜者的赛前概率低于10%。' },
  },
};

export function terminology(group: keyof typeof terms, value: string | null | undefined): Term {
  if (!value) return { label: '未记录', definition: '当前记录没有提供该状态。' };
  return terms[group][value] ?? { label: '未识别状态', definition: `系统保存了状态代码，但当前界面尚未定义其中文含义。` };
}
