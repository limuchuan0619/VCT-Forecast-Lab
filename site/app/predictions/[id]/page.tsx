/* oxlint-disable next/no-html-link-for-pages -- Full-page navigation is intentional for embedded-browser reliability. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BrainCircuit, ExternalLink, LockKeyhole } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { PredictionLifecycle } from '@/components/prediction-lifecycle';
import { ProbabilityWaterfall } from '@/components/probability-waterfall';
import { predictionRecordById } from '@/lib/prediction-store';
import { chinaTime, percent, predictionWinner, probabilityPointDelta, regionLabel } from '@/lib/view-helpers';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const record = await predictionRecordById(decodeURIComponent(id));
  if (!record) return { title: '预测不存在｜VCT Forecast Lab' };
  return {
    title: `${record.teamA} vs ${record.teamB}｜预测详情`,
    description: `${record.event} 的赛前锁定概率、变量贡献、地图概率和 DeepSeek 差异。`,
    openGraph: { images: [] },
    twitter: { images: [] },
  };
}

export default async function PredictionDetailPage({ params }: Props) {
  const { id } = await params;
  const record = await predictionRecordById(decodeURIComponent(id));
  if (!record) notFound();
  const probabilityB = 1 - record.teamAProbability;
  const factors = [...record.factors].sort((a, b) => a.rank - b.rank);
  const maxFactor = Math.max(...factors.map((factor) => Math.abs(factor.probabilityPoints)), 0.01);
  const mathWinner = predictionWinner(record.teamA, record.teamB, record.teamAProbability);
  const aiProbability = record.prematchAnalysis?.ai_probability_team_a;
  const aiWinner = aiProbability === undefined ? null : predictionWinner(record.teamA, record.teamB, aiProbability);
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">跳到主要内容</a>
      <SiteHeader active="predictions" />
      <main id="main" className="dashboard subpage-dashboard">
        <a className="back-link" href="/predictions">← 返回预测历史</a>
        <section className="detail-hero">
          <div><span className="eyebrow">{regionLabel(record.region)} · {chinaTime(record.scheduledAt)} · {record.seriesFormat.toUpperCase()}</span><h1>{record.teamA} <i>vs</i> {record.teamB}</h1><p>{record.event}</p></div>
          <div className="detail-lock"><LockKeyhole /><span>赛前快照</span><strong>{record.status === 'resolved' ? '已结算' : '已锁定'}</strong></div>
        </section>

        <PredictionLifecycle record={record} />

        <section className="probability-comparison" aria-label="数学模型与 DeepSeek 概率对照">
          <article className="comparison-card math-card">
            <span className="eyebrow">OFFICIAL · 数学模型</span>
            <h2>{mathWinner}</h2>
            <strong>{percent(Math.max(record.teamAProbability, probabilityB))}</strong>
            <div className="comparison-split"><span>{record.teamA} {percent(record.teamAProbability)}</span><span>{record.teamB} {percent(probabilityB)}</span></div>
            <div className="mini-probability"><span style={{ width: `${record.teamAProbability * 100}%` }} /></div>
            <p>正式比分预测 {record.predictedScore} · 用于成绩结算</p>
          </article>
          <article className="comparison-card ai-card">
            <span className="eyebrow">SHADOW · DEEPSEEK</span>
            {record.prematchAnalysis && aiProbability !== undefined ? <>
              <h2>{aiWinner}</h2>
              <strong>{percent(Math.max(aiProbability, 1 - aiProbability))}</strong>
              <div className="comparison-split"><span>{record.teamA} {percent(aiProbability)}</span><span>{record.teamB} {percent(1 - aiProbability)}</span></div>
              <div className="mini-probability ai-line"><span style={{ width: `${aiProbability * 100}%` }} /></div>
              <p>相对数学模型 A 队 {probabilityPointDelta(aiProbability - record.teamAProbability)} · {aiWinner === mathWinner ? '胜者方向一致' : '胜者方向分歧'}</p>
            </> : <div className="analysis-missing"><BrainCircuit /><h2>没有可用的影子概率</h2><p>{record.source.startsWith('human') ? '这是历史人工预测，赛前没有保存可回溯的系统变量与 DeepSeek 分析。' : `当前状态：${record.prematchAiStatus ?? '等待分析'}`}</p></div>}
          </article>
        </section>

        {record.prematchAnalysis && <section className="detail-section ai-v2-analysis">
          <header className="section-heading"><div><span className="eyebrow">DEEPSEEK ANALYSIS V2 · SHADOW</span><h2>可验证的赛前分析</h2></div><p>证据等级 {record.prematchAnalysis.evidence_grade ?? '旧版未记录'}；本段不参与正式概率计算。</p></header>
          <p className="review-summary">{record.prematchAnalysis.summary}</p>
          <div className="review-columns">
            <div><h3>{record.teamA} 的胜利条件</h3><ul>{(record.prematchAnalysis.team_a_win_conditions ?? record.prematchAnalysis.upset_conditions).map((item) => <li key={item}>{item}</li>)}</ul></div>
            <div><h3>{record.teamB} 的胜利条件</h3><ul>{(record.prematchAnalysis.team_b_win_conditions ?? record.prematchAnalysis.risk_flags).map((item) => <li key={item}>{item}</li>)}</ul></div>
          </div>
          {record.prematchAnalysis.uncertainty && <div className="review-columns">
            <div><h3>缺失与低样本</h3><ul>{[...record.prematchAnalysis.uncertainty.missing_data, ...record.prematchAnalysis.uncertainty.low_sample_signals].map((item) => <li key={item}>{item}</li>)}</ul></div>
            <div><h3>判断失效触发器</h3><ul>{record.prematchAnalysis.uncertainty.invalidation_triggers.map((item) => <li key={item}>{item}</li>)}</ul></div>
          </div>}
          {record.prematchAnalysis.map_analysis && record.prematchAnalysis.map_analysis.length > 0 && <div className="map-probability-grid ai-map-reading">{record.prematchAnalysis.map_analysis.map((map) => <article key={map.map}>
            <span>{map.map}</span><strong>{percent(map.team_a_probability)}</strong><small>DeepSeek 对 A 队的影子判断</small>
            <p>{map.interpretation}</p><footer><span>{map.sample_warning}</span></footer>
          </article>)}</div>}
          {record.prematchAnalysis.structured_hypotheses && record.prematchAnalysis.structured_hypotheses.length > 0 && <div className="boundary-note"><strong>只进入影子实验的优化假设</strong>{record.prematchAnalysis.structured_hypotheses.map((item) => <p key={`${item.target_feature}:${item.hypothesis}`}><b>{item.target_feature}</b>：{item.hypothesis}；验证：{item.validation_plan}</p>)}</div>}
        </section>}

        <ProbabilityWaterfall record={record} />

        <section className="detail-section">
          <header className="section-heading"><div><span className="eyebrow">FACTOR ATTRIBUTION</span><h2>变量贡献</h2></div><p>正值支持 {record.teamA}，负值支持 {record.teamB}；单位为最终胜率的百分点变化。</p></header>
          {factors.length > 0 ? <div className="factor-table">
            <div className="factor-axis" aria-hidden="true"><span>支持 {record.teamB}</span><i>0</i><span>支持 {record.teamA}</span></div>
            {factors.map((factor) => {
              const width = Math.max(2, Math.abs(factor.probabilityPoints) / maxFactor * 48);
              return <article key={factor.key} className="factor-row">
                <span className="factor-rank">{String(factor.rank).padStart(2, '0')}</span>
                <div className="factor-copy"><strong>{factor.label}</strong><small>{factor.detail}</small></div>
                <div className="factor-plot"><i className="zero" /><b className={factor.probabilityPoints > 0 ? 'positive' : 'negative'} style={{ width: `${width}%` }} /></div>
                <strong className={factor.probabilityPoints > 0 ? 'factor-value positive-text' : 'factor-value negative-text'}>{factor.probabilityPoints > 0 ? '+' : ''}{factor.probabilityPoints.toFixed(2)}pp</strong>
                <span className="factor-share">{percent(factor.absoluteShare)}</span>
              </article>;
            })}
          </div> : <div className="boundary-note"><strong>历史记录没有变量快照</strong><p>只展示真实保存的赛前概率和比分，不根据赛果倒推或伪造变量占比。</p></div>}
        </section>

        <section className="detail-section">
          <header className="section-heading"><div><span className="eyebrow">MAP MODEL</span><h2>独立地图概率</h2></div><p>地图模型独立于整体 Rating；显示的是锁定时每张候选地图的双方胜率。</p></header>
          {record.maps.length > 0 ? <div className="map-probability-grid">{record.maps.map((map) => <article key={map.map}>
            <span>{map.map}</span><strong>{percent(map.teamAProbability)}</strong><small>{record.teamA}</small>
            <div className="mini-probability"><span style={{ width: `${map.teamAProbability * 100}%` }} /></div>
            <footer><span>{record.teamB} {percent(map.teamBProbability)}</span>{map.samples && <span>样本 {map.samples[0]} / {map.samples[1]}</span>}</footer>
          </article>)}</div> : <div className="boundary-note"><strong>没有地图概率快照</strong><p>该记录来自旧版人工档案，未在赛前保存地图模型输出。</p></div>}
        </section>

        <section className="detail-grid">
          <article className="score-panel"><span className="eyebrow">SCORE DISTRIBUTION</span><h2>比分分布</h2>{Object.entries(record.scoreDistribution).sort((a, b) => b[1] - a[1]).map(([score, probability]) => <div className="score-row" key={score}><span>{score}</span><i><b style={{ width: `${probability * 100}%` }} /></i><strong>{percent(probability)}</strong></div>)}{Object.keys(record.scoreDistribution).length === 0 && <p className="muted-copy">历史档案未保存比分分布。</p>}</article>
          <article className="evidence-panel"><span className="eyebrow">LOCKED EVIDENCE</span><h2>证据与边界</h2><dl><div><dt>模型版本</dt><dd>{record.modelVersion}</dd></div><div><dt>锁定时间</dt><dd>{chinaTime(record.lockedAt)}</dd></div><div><dt>数据截止</dt><dd>{chinaTime(record.dataCutoffAt)}</dd></div><div><dt>Patch</dt><dd>{record.patch ?? '未记录'}</dd></div><div><dt>质量门</dt><dd>{record.evidence.qualityGate}</dd></div>{record.status === 'resolved' && <div><dt>实际结果</dt><dd>{record.actualWinner} {record.actualScore}</dd></div>}</dl>{record.evidence.sourceUrl && <a href={record.evidence.sourceUrl} rel="noreferrer" target="_blank">查看来源 <ExternalLink /></a>}</article>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
