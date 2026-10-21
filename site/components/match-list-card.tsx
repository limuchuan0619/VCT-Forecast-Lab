import type { PredictionRecord } from '@/lib/vct-types';
import {
  chinaTime,
  percent,
  predictionWinner,
  regionLabel,
} from '@/lib/view-helpers';
import { resultSentence, reviewSummary } from '@/lib/presentation';
import { terminology } from '@/lib/terminology';
import { predictionHeadline, readerStatus } from '@/lib/reader-analysis';
import { TeamLogo } from '@/components/team-logo';

export function MatchListCard({
  record,
  review = false,
  compact = false,
  featured = false,
}: {
  record: PredictionRecord;
  review?: boolean;
  compact?: boolean;
  featured?: boolean;
}) {
  const winner = predictionWinner(
    record.teamA,
    record.teamB,
    record.teamAProbability,
  );
  const resolved = record.status === 'resolved';
  const detailUrl = `/predictions/${encodeURIComponent(record.id)}${review ? '?view=postmatch' : ''}`;
  const probabilityLabel = (value: number) =>
    Number.isFinite(value) && value >= 0 && value <= 1
      ? percent(value)
      : '暂无胜率';
  if (compact)
    return (
      <article className="history-row">
        <div>
          <span className="reader-note">
            {chinaTime(record.scheduledAt)} · {regionLabel(record.region)}
          </span>
          <h2>
            <a
              href={`/predictions/${encodeURIComponent(record.id)}${review ? '?view=postmatch' : ''}`}
            >
              <span className="team-name">
                <TeamLogo team={record.teamA} />
                {record.teamA}
              </span>
              <i>对阵</i>
              <span className="team-name">
                <TeamLogo team={record.teamB} />
                {record.teamB}
              </span>
            </a>
          </h2>
          <p className="reader-note">{record.event}</p>
        </div>
        <div>
          <p>
            {review && resolved
              ? resultSentence(record)
              : `${record.teamA} ${probabilityLabel(record.teamAProbability)} · ${record.teamB} ${probabilityLabel(1 - record.teamAProbability)}`}
          </p>
          <small>
            {review
              ? `文字复盘：${readerStatus(record.postmatchJob?.status ?? record.postmatchAiStatus)}`
              : resolved
                ? resultSentence(record)
                : '赛前判断已保存'}
          </small>
        </div>
        <a
          className="history-link"
          href={`/predictions/${encodeURIComponent(record.id)}${review ? '?view=postmatch' : ''}`}
        >
          {review ? '阅读复盘' : '查看分析'} ↗
        </a>
      </article>
    );
  return (
    <article className={`match-list-card${featured ? ' featured-match' : ''}`}>
      <a
        className="card-open"
        href={detailUrl}
        aria-label={`${record.teamA} 对阵 ${record.teamB}，${review ? '查看复盘' : '查看预测依据'}`}
      />
      <header>
        <span>
          {chinaTime(record.scheduledAt)} · {regionLabel(record.region)}
        </span>
        <span className="match-state">
          {resolved ? '比赛已结束' : '赛前预测已保存'}
        </span>
      </header>
      <div className="card-format">
        <span>
          {record.seriesFormat === 'bo5' ? 'BO5 · 五局三胜' : 'BO3 · 三局两胜'}
        </span>
        {featured && <span className="featured-label">重点关注</span>}
      </div>
      <h2 className="sr-only">
        {record.teamA} 对阵 {record.teamB}
      </h2>
      <div className="card-teams" aria-label="系统预测胜率">
        {[
          { team: record.teamA, probability: record.teamAProbability },
          { team: record.teamB, probability: 1 - record.teamAProbability },
        ].map(({ team, probability }) => (
          <div className="card-team" key={team}>
            <span className="team-name">
              <TeamLogo team={team} />
              <span>{team}</span>
            </span>
            <strong
              className={
                Number.isFinite(probability) &&
                probability >= 0.5 &&
                probability <= 1
                  ? 'favored-probability'
                  : undefined
              }
            >
              {probabilityLabel(probability)}
            </strong>
          </div>
        ))}
      </div>
      <div className="card-forecast">
        <div>
          <small>系统预测</small>
          <strong>{predictionHeadline(record)}</strong>
        </div>
        <div className="card-score">
          <small>预计比分</small>
          <strong>{record.predictedScore.replace('-', ':')}</strong>
        </div>
      </div>
      <p className="card-score-order">
        比分按 {record.teamA} : {record.teamB} 排列
      </p>
      {resolved && (
        <p className="match-result">
          {review ? reviewSummary(record) : resultSentence(record)}
        </p>
      )}
      <footer>
        <p className="match-event">{record.event}</p>
        <div className="card-footer-bottom">
          <span>
            {review
              ? `赛后复盘：${record.postmatchReview ? '已完成' : terminology('aiStatus', record.postmatchAiStatus ?? 'waiting').label}`
              : resolved
                ? `胜者判断${(record.scorecard?.winnerCorrect ?? winner === record.actualWinner) ? '正确' : '未命中'}`
                : `赛前 AI 分析：${terminology('aiStatus', record.prematchAiStatus ?? 'waiting').label}`}
          </span>
          <span className="card-action" aria-hidden="true">
            {review ? '查看复盘' : '查看预测依据'}
          </span>
        </div>
      </footer>
    </article>
  );
}
