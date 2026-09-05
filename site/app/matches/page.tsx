import type { Metadata } from 'next';
import { ArrowUpRight, BrainCircuit, CircleCheck, LockKeyhole } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { listPredictionRecords } from '@/lib/prediction-store';
import { chinaTime, percent, predictionLifecycle, predictionWinner, regionLabel } from '@/lib/view-helpers';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '近期预测｜VCT Forecast Lab', description: '按四大赛区查看由 VCT Forecast Lab 实际锁定过的近期比赛预测。' };
const regions = ['CN', 'EMEA', 'AMERICAS', 'PACIFIC'] as const;

export default async function MatchesPage() {
  const records = await listPredictionRecords(100);
  return <div className="site-shell">
    <a className="skip-link" href="#main">跳到主要内容</a><SiteHeader active="matches" />
    <main id="main" className="dashboard subpage-dashboard">
      <section className="page-hero"><div><span className="eyebrow">FORECASTED MATCHES ONLY</span><h1>四赛区预测视图</h1></div><p>这里只呈现本网站在赛前真正锁定过的比赛。后台历史赛果用于训练与更新 Rating，但不会混入网站预测履历。</p></section>
      <section className="region-board prediction-board">
        {regions.map((region) => {
          const regionRecords = records.filter((record) => record.region === region).slice(0, 10);
          return <article className="region-lane" key={region}>
            <header><div><span>{region}</span><h2>{regionLabel(region)}</h2></div><strong>{regionRecords.length}<small> 场预测</small></strong></header>
            {regionRecords.map((record) => {
              const winner = predictionWinner(record.teamA, record.teamB, record.teamAProbability);
              const lifecycle = predictionLifecycle(record);
              return <div className={`match-tile ${record.status === 'locked' ? 'upcoming' : ''}`} key={record.id}>
                <span className="match-time">{chinaTime(record.scheduledAt)}</span>
                <h3><span className={winner === record.teamA ? 'winner' : ''}>{record.teamA}</span><strong>{record.predictedScore.replace('-', '—')}</strong><span className={winner === record.teamB ? 'winner' : ''}>{record.teamB}</span></h3>
                <p>{record.event}</p>
                <div className="mini-probability"><span style={{ width: `${record.teamAProbability * 100}%` }} /></div>
                <div className="tile-probabilities"><span>{record.teamA} {percent(record.teamAProbability)}</span><span>{record.teamB} {percent(1 - record.teamAProbability)}</span></div>
                <footer>
                  <span>{record.status === 'resolved' ? <><CircleCheck /> 实际 {record.actualWinner} {record.actualScore}</> : <><LockKeyhole /> 赛前已锁定</>}</span>
                  <span>{record.prematchAnalysis ? <><BrainCircuit /> AI 已对照</> : lifecycle.label}</span>
                  <a href={`/predictions/${encodeURIComponent(record.id)}`}>过程 <ArrowUpRight /></a>
                </footer>
              </div>;
            })}
            {regionRecords.length === 0 && <p className="lane-empty">网站尚未在该赛区锁定预测。</p>}
          </article>;
        })}
      </section>
    </main><SiteFooter />
  </div>;
}
