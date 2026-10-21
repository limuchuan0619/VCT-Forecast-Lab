import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { PredictionReading } from '@/components/prediction-reading';
import { MatchReview } from '@/components/match-review';
import { predictionRecordById } from '@/lib/prediction-store';
import { predictionHeadline, readerStatus } from '@/lib/reader-analysis';
import {
  modelNames,
  modelProbabilities,
  resultSentence,
  reviewSummary,
} from '@/lib/presentation';
import { chinaTime, percent, regionLabel } from '@/lib/view-helpers';
import { TeamLogo } from '@/components/team-logo';

export const dynamic = 'force-dynamic';
type Props = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ view?: string }>;
};
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const record = await predictionRecordById(
    decodeURIComponent((await params).id),
  );
  return record
    ? {
        title: `${record.teamA} 对阵 ${record.teamB}｜比赛分析`,
        description: `${record.event}的赛前预测与赛后复盘。`,
        openGraph: { images: [] },
        twitter: { images: [] },
      }
    : { title: '未找到比赛｜VCT Forecast Lab' };
}
export default async function PredictionDetailPage({
  params,
  searchParams,
}: Props) {
  const record = await predictionRecordById(
    decodeURIComponent((await params).id),
  );
  if (!record) notFound();
  // Old audit/advanced links no longer expose raw records on public pages.
  const postmatch = (await searchParams)?.view === 'postmatch';
  const url = `/predictions/${encodeURIComponent(record.id)}`;
  const probabilities = modelProbabilities(record);
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <SiteHeader active={postmatch ? 'reviews' : 'predictions'} />
      <main id="main" className="dashboard reader-dashboard match-detail">
        <a className="back-link" href={postmatch ? '/reviews' : '/predictions'}>
          ← 返回{postmatch ? '赛后复盘' : '预测历史'}
        </a>
        <section className="reader-heading">
          <div>
            <span className="reader-kicker">
              {regionLabel(record.region)} · {chinaTime(record.scheduledAt)} ·{' '}
              {record.seriesFormat === 'bo5' ? '五局三胜' : '三局两胜'}
            </span>
            <h1 className="detail-teams">
              <span className="team-name">
                <TeamLogo team={record.teamA} />
                {record.teamA}
              </span>
              <span className="muted-versus">对阵</span>
              <span className="team-name">
                <TeamLogo team={record.teamB} />
                {record.teamB}
              </span>
            </h1>
            <p>{record.event}</p>
          </div>
        </section>
        <nav className="reader-filters detail-tabs" aria-label="比赛详情">
          <a className={!postmatch ? 'selected' : ''} href={url}>
            赛前预测
          </a>
          <a
            className={postmatch ? 'selected' : ''}
            href={`${url}?view=postmatch`}
          >
            赛后复盘
          </a>
        </nav>
        {!postmatch ? (
          <>
            <section className="detail-section">
              <h2>{predictionHeadline(record)}</h2>
              <div className="match-probabilities">
                <span>
                  {record.teamA}
                  <strong>{percent(record.teamAProbability)}</strong>
                </span>
                <span>
                  {record.teamB}
                  <strong>{percent(1 - record.teamAProbability)}</strong>
                </span>
              </div>
              <div
                className="mini-probability"
                role="img"
                aria-label={`双方胜率：${percent(record.teamAProbability)} 对 ${percent(1 - record.teamAProbability)}`}
              >
                <span style={{ width: `${record.teamAProbability * 100}%` }} />
              </div>
              <p className="reader-note">
                预计比分 {record.teamA}{' '}
                {record.predictedScore.replace('-', ':')} {record.teamB}
                。这不是确定的结果。
              </p>
            </section>
            <section className="detail-section">
              <h2>为什么这样判断？</h2>
              <PredictionReading record={record} />
            </section>
            <details className="reader-disclosure">
              <summary>查看各地图的赛前胜率</summary>
              <p className="reader-note">
                仅表示候选地图的判断，实际选图尚不一定如此。
              </p>
              <div className="simple-map-list">
                {record.maps.map((map) => (
                  <div key={map.map}>
                    <strong>{map.map}</strong>
                    <span>
                      {record.teamA} {percent(map.teamAProbability)}
                    </span>
                    <span>
                      {record.teamB} {percent(map.teamBProbability)}
                    </span>
                  </div>
                ))}
              </div>
              {!record.maps.length && <p>没有保存地图判断。</p>}
            </details>
            <details className="reader-disclosure">
              <summary>其他预测怎么看这场？</summary>
              <p>
                以下均为 {record.teamA} 的赛前胜率。AI
                参考分析能看到系统预测，不是完全独立的判断。
              </p>
              <ul className="plain-model-list">
                {(['champion', 'c1', 'deepseek'] as const).map((model) => (
                  <li key={model}>
                    <span>{modelNames[model]}</span>
                    <strong>
                      {probabilities[model] === null
                        ? '没有合格的赛前记录'
                        : percent(probabilities[model]!)}
                    </strong>
                  </li>
                ))}
              </ul>
              <a href="/matches">查看长期表现 →</a>
            </details>
            <p className="reader-note">
              赛前 AI 分析：{readerStatus(record.prematchAiStatus)}
              。赛前预测保存后，不会根据赛果修改。
            </p>
          </>
        ) : (
          <section className="detail-section">
            {record.status === 'resolved' ? (
              <>
                <p className="result-title">{resultSentence(record)}</p>
                <MatchReview record={record} />
                <details className="reader-disclosure model-deviation">
                  <summary>回看赛前判断</summary>
                  <p>
                    {record.teamA} 当时的胜率为{' '}
                    {percent(record.teamAProbability)}，{record.teamB} 为{' '}
                    {percent(1 - record.teamAProbability)}。
                  </p>
                  <p>{reviewSummary(record)}</p>
                  <p>
                    接近五五开的判断本来就允许两种结果；一场胜负不能说明模型长期好坏。
                  </p>
                  <a href={url}>查看当时的预测依据 →</a>
                </details>
              </>
            ) : (
              <div className="reader-empty">
                <h2>比赛结果尚未确认</h2>
                <p>结果确认后会自动整理复盘，现在可以先查看赛前预测。</p>
                <a href={url}>查看赛前预测 →</a>
              </div>
            )}
          </section>
        )}
        <div className="source-line">
          <span>预测保存于 {chinaTime(record.lockedAt)}</span>
          {record.evidence.sourceUrl &&
            /^https:\/\/(www\.)?vlr\.gg\//.test(record.evidence.sourceUrl) && (
              <a
                href={record.evidence.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                比赛资料：VLR ↗
              </a>
            )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
