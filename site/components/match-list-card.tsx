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

export function MatchListCard({
  record,
  review = false,
  compact = false,
}: {
  record: PredictionRecord;
  review?: boolean;
  compact?: boolean;
}) {
  const winner = predictionWinner(
    record.teamA,
    record.teamB,
    record.teamAProbability,
  );
  const resolved = record.status === 'resolved';
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
              {record.teamA} <i>对阵</i> {record.teamB}
            </a>
          </h2>
          <p className="reader-note">{record.event}</p>
        </div>
        <div>
          <p>
            {review && resolved
              ? resultSentence(record)
              : `${record.teamA} ${percent(record.teamAProbability)} · ${record.teamB} ${percent(1 - record.teamAProbability)}`}
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
    <article className="match-list-card">
      <header>
        <span>
          {chinaTime(record.scheduledAt)} · {regionLabel(record.region)}
        </span>
        <span className="match-state">
          {resolved ? '比赛已结束' : '赛前预测已保存'}
        </span>
      </header>
      <h2>
        {record.teamA} <i>vs</i> {record.teamB}
      </h2>
      <p className="match-event">{record.event}</p>
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
        aria-label={`${record.teamA} ${percent(record.teamAProbability)}，${record.teamB} ${percent(1 - record.teamAProbability)}`}
      >
        <span style={{ width: `${record.teamAProbability * 100}%` }} />
      </div>
      <p className="match-pick">
        <strong>{predictionHeadline(record)}</strong>
        <span>
          预计比分 {record.predictedScore.replace('-', ':')}（{record.teamA}{' '}
          在前）
        </span>
      </p>
      {resolved && (
        <p className="match-result">
          {review ? reviewSummary(record) : resultSentence(record)}
        </p>
      )}
      <footer>
        <span>
          {review
            ? `赛后复盘：${record.postmatchReview ? '已完成' : terminology('aiStatus', record.postmatchAiStatus ?? 'waiting').label}`
            : resolved
              ? `胜者判断${(record.scorecard?.winnerCorrect ?? winner === record.actualWinner) ? '正确' : '未命中'}`
              : `赛前 AI 分析：${terminology('aiStatus', record.prematchAiStatus ?? 'waiting').label}`}
        </span>
        <a
          href={`/predictions/${encodeURIComponent(record.id)}${review ? '?view=postmatch' : ''}`}
        >
          {review ? '查看复盘' : '查看预测依据'}
        </a>
      </footer>
    </article>
  );
}
