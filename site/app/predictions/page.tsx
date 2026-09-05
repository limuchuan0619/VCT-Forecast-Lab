import type { Metadata } from 'next';
import { Activity, ArrowUpRight, BrainCircuit, Database, LockKeyhole } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { listPredictionRecords } from '@/lib/prediction-store';
import { chinaTime, percent, predictionLifecycle, predictionWinner, probabilityPointDelta, regionLabel } from '@/lib/view-helpers';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '预测历史｜VCT Forecast Lab',
  description: '查看每场 VCT 赛前锁定概率、数学模型快照与 DeepSeek 影子分析差异。',
};

export default async function PredictionsPage() {
  const records = await listPredictionRecords(100);
  const withAi = records.filter((record) => record.prematchAnalysis).length;
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">跳到主要内容</a>
      <SiteHeader active="predictions" />
      <main id="main" className="dashboard subpage-dashboard">
        <section className="page-hero">
          <div><span className="eyebrow">IMMUTABLE PREMATCH LEDGER</span><h1>预测历史</h1></div>
          <p>这里只展示系统自动生成的正式预测。每条记录保存赛前概率与证据，赛后只追加结果，绝不回写原始判断。</p>
        </section>

        <section className="summary-rail" aria-label="预测历史概况">
          <div><span>系统预测</span><strong>{records.length}</strong></div>
          <div><span>已结算</span><strong>{records.filter((record) => record.status === 'resolved').length}</strong></div>
          <div><span>影子分析</span><strong>{withAi}</strong></div>
          <div><span>变量快照</span><strong>{records.filter((record) => record.factors.length > 0).length}</strong></div>
        </section>

        <section className="record-list" aria-label="预测记录列表">
          {records.length === 0 && <div className="empty-state"><Database /><h2>还没有预测记录</h2><p>云端下一轮同步后会自动出现。</p></div>}
          {records.map((record) => {
            const winner = predictionWinner(record.teamA, record.teamB, record.teamAProbability);
            const aiDelta = record.prematchAnalysis ? record.prematchAnalysis.ai_probability_team_a - record.teamAProbability : null;
            const aiWinner = record.prematchAnalysis
              ? predictionWinner(record.teamA, record.teamB, record.prematchAnalysis.ai_probability_team_a)
              : null;
            const lifecycle = predictionLifecycle(record);
            return (
              <article className="record-card" key={record.id}>
                <div className="record-meta">
                  <span>{regionLabel(record.region)} · {chinaTime(record.scheduledAt)}</span>
                  <small>{record.event}</small>
                </div>
                <div className="record-match">
                  <h2>{record.teamA} <i>vs</i> {record.teamB}</h2>
                  <div className="mini-probability"><span style={{ width: `${record.teamAProbability * 100}%` }} /></div>
                  <p><strong>{winner}</strong> {percent(Math.max(record.teamAProbability, 1 - record.teamAProbability))} · 比分 {record.predictedScore}</p>
                </div>
                <div className="record-signals">
                  <span><LockKeyhole /> 数学模型 {percent(record.teamAProbability)} / {percent(1 - record.teamAProbability)}</span>
                  {record.prematchAnalysis ? (
                    <span className={aiWinner === winner ? 'ai-agree' : 'ai-disagree'}>
                      <BrainCircuit /> DeepSeek {probabilityPointDelta(aiDelta ?? 0)} · {aiWinner === winner ? '方向一致' : '方向分歧'}
                    </span>
                  ) : <span className="muted-signal"><BrainCircuit /> AI {record.prematchAiStatus ?? '等待分析'}</span>}
                  <span className="lifecycle-signal"><Activity /> {lifecycle.label}</span>
                  <span className="result-signal">{record.status === 'resolved' ? `实际 ${record.actualWinner} ${record.actualScore}` : '比赛尚未结算'}</span>
                </div>
                <a className="record-link" href={`/predictions/${encodeURIComponent(record.id)}`} aria-label={`查看 ${record.teamA} 对 ${record.teamB} 的完整预测`}><ArrowUpRight /></a>
              </article>
            );
          })}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
