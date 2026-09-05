import type { Metadata } from 'next';
import { ArrowUpRight, BrainCircuit, CircleCheck, CircleDashed } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { listPostmatchReviewRecords } from '@/lib/prediction-store';
import { chinaTime, regionLabel } from '@/lib/view-helpers';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '赛后复盘｜VCT Forecast Lab', description: '查看 VCT 预测赛后复盘、误差来源和受控优化建议。' };

const classification = {
  normal_variance: '正常波动', calibration_issue: '概率校准问题', data_issue: '数据问题', candidate_model_issue: '候选模型问题',
};

export default async function ReviewsPage() {
  const records = await listPostmatchReviewRecords(100);
  const complete = records.filter((record) => record.postmatchReview);
  return <div className="site-shell">
    <a className="skip-link" href="#main">跳到主要内容</a><SiteHeader active="reviews" />
    <main id="main" className="dashboard subpage-dashboard">
      <section className="page-hero"><div><span className="eyebrow">POSTMATCH REVIEW LEDGER</span><h1>赛后复盘</h1></div><p>DeepSeek 读取赛前锁定快照与实际赛果，解释误差并提出候选实验；正式模型不会被一场比赛直接改写。</p></section>
      <section className="summary-rail"><div><span>已结算比赛</span><strong>{records.length}</strong></div><div><span>完整 AI 复盘</span><strong>{complete.length}</strong></div><div><span>等待或跳过</span><strong>{records.length - complete.length}</strong></div><div><span>直接改权</span><strong>禁止</strong></div></section>
      <section className="review-list">
        {complete.map((record) => {
          const review = record.postmatchReview!;
          return <article className="review-card" key={record.id}>
            <header><div><span className="eyebrow">{regionLabel(record.region)} · {chinaTime(record.resolvedAt ?? record.scheduledAt)}</span><h2>{record.teamA} <i>vs</i> {record.teamB}</h2><p>预测 {record.predictedScore} · 实际 {record.actualWinner} {record.actualScore}</p></div><span className="review-status"><CircleCheck />{classification[review.result_classification]}</span></header>
            <p className="review-summary">{review.summary}</p>
            {review.outcome_evaluation && <div className="boundary-note"><strong>结果判断：胜者{review.outcome_evaluation.winner_correct ? '命中' : '未命中'} · 比分{review.outcome_evaluation.score_correct ? '命中' : '未命中'} · 概率{review.outcome_evaluation.probability_was_reasonable ? '仍属合理' : '需要校准检查'}</strong><p>{review.outcome_evaluation.calibration_comment}</p></div>}
            <div className="review-columns"><div><h3>主要误差驱动</h3><ul>{review.error_drivers.map((item) => <li key={item}>{item}</li>)}</ul></div><div><h3>候选优化假设</h3><ul>{review.structured_hypotheses?.map((item) => <li key={`${item.target_feature}:${item.hypothesis}`}><strong>{item.target_feature}</strong>：{item.hypothesis}；验证：{item.validation_plan}</li>) ?? review.candidate_hypotheses.map((item) => <li key={item}>{item}</li>)}</ul></div></div>
            {(review.validated_factors || review.invalidated_factors) && <div className="review-columns"><div><h3>被赛果支持的变量</h3><ul>{(review.validated_factors ?? []).map((item) => <li key={item}>{item}</li>)}</ul></div><div><h3>被赛果质疑的变量</h3><ul>{(review.invalidated_factors ?? []).map((item) => <li key={item}>{item}</li>)}</ul></div></div>}
            {review.map_review && review.map_review.length > 0 && <div className="boundary-note"><strong>地图复盘</strong>{review.map_review.map((item) => <p key={`${item.map}:${item.conclusion}`}><b>{item.map}</b>：赛前 {item.pre_match_reading}；赛后证据 {item.actual_evidence}；结论 {item.conclusion}</p>)}</div>}
            {review.variance_vs_model_error && <div className="boundary-note"><strong>随机波动与模型误差判断：{review.variance_vs_model_error.verdict}</strong><p>{review.variance_vs_model_error.explanation}</p></div>}
            <footer><span><BrainCircuit /> {review.retraining_recommendation === 'shadow_experiment' ? '进入影子实验候选' : '无需重训'}</span><a href={`/predictions/${encodeURIComponent(record.id)}`}>查看赛前快照 <ArrowUpRight /></a></footer>
          </article>;
        })}
        {records.filter((record) => !record.postmatchReview).map((record) => <article className="review-pending" key={record.id}><CircleDashed /><div><h2>{record.teamA} vs {record.teamB}</h2><p>{record.actualWinner} {record.actualScore} · 复盘状态：{record.postmatchAiStatus ?? '等待生成'}</p></div><a href={`/predictions/${encodeURIComponent(record.id)}`}><ArrowUpRight /></a></article>)}
      </section>
    </main><SiteFooter />
  </div>;
}
