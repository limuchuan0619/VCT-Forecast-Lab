import type { PredictionRecord } from '@/lib/vct-types';
import { agentName } from '@/lib/reader-analysis';
import { verifiedReaderReview, verifiedTeamReviews } from '@/lib/match-review';
import { plainText } from '@/lib/presentation';

export function MatchReview({ record }: { record: PredictionRecord }) {
  const ai = verifiedReaderReview(record);
  const legacy = ai
    ? []
    : verifiedTeamReviews(record).filter(
        (team) =>
          team.strengths.length ||
          team.weaknesses.length ||
          team.possible_explanation,
      );
  // Completion of an older model-diagnosis job is not completion of the
  // reader-facing article. Never manufacture an analysis from a stats template.
  if (!ai)
    return (
      <article className="reader-prose match-review-primary">
        <section className="reading-section">
          <h2>比赛复盘</h2>
          <p className="reader-note">
            {record.postmatchJob?.status === 'FINAL_FAILED' ||
            record.postmatchReview?.reader_review
              ? '详细解读暂时无法提供。'
              : '详细解读尚未生成。'}
            {legacy.length
              ? '下面保留此前的简要复盘。'
              : '先保留已确认的比赛结果。'}
          </p>
          {legacy.map((team) => (
            <section className="plain-reason" key={team.team}>
              <h3>{team.team}</h3>
              {[...team.strengths, ...team.weaknesses].map((claim, i) => (
                <p key={i}>{plainText(claim.claim, record)}</p>
              ))}
              {team.possible_explanation && (
                <p>{plainText(team.possible_explanation.claim, record)}</p>
              )}
            </section>
          ))}
          {!legacy.length && (
            <p>已确认的比赛结果保留在上方；分析准备好后会在这里显示。</p>
          )}
        </section>
      </article>
    );
  return (
    <article className="reader-prose match-review-primary">
      {record.postmatchJob && record.postmatchJob.status !== 'SUCCESS' && (
        <p className="reader-note">
          下面保留此前生成的复盘。
          {record.postmatchJob.status === 'FINAL_FAILED'
            ? '新版解读暂未完成，当前展示的仍是此前内容。'
            : '新版解读正在整理，完成核验后才会替换。'}
        </p>
      )}
      <p className="reading-lead">{plainText(ai.summary, record)}</p>
      {!!ai.reasons.length && (
        <section className="reading-section">
          <h2>胜负的分野</h2>
          {ai.reasons.map((reason, index) => (
            <section className="plain-reason" key={index}>
              {reason.title && <h3>{plainText(reason.title, record)}</h3>}
              <p>
                {plainText(reason.fact, record)}{' '}
                {plainText(reason.interpretation, record)}
              </p>
            </section>
          ))}
        </section>
      )}
      <section className="reading-section">
        <h2>地图拆解</h2>
        {ai.maps.map((map) => {
          const pairs = ai.matchups.filter(
            (pair) => pair.mapOrder === map.order,
          );
          const source = record.resultEvidence!.maps.find(
            (m) => m.order === map.order,
          )!;
          return (
            <section className="map-reading" key={map.order}>
              <header>
                <h3>{map.map}</h3>
                <strong>
                  {source.teamAScore}:{source.teamBScore}
                </strong>
              </header>
              <p>
                {plainText(map.fact, record)}{' '}
                {plainText(map.interpretation, record)}
              </p>
              {!!pairs.length &&
                pairs.map((pair) => (
                  <div key={pair.agent}>
                    <p className="reader-note">
                      同英雄表现 · {agentName(pair.agent)}
                    </p>
                    <p>
                      {plainText(pair.fact, record)}{' '}
                      {plainText(pair.interpretation, record)}
                    </p>
                  </div>
                ))}
            </section>
          );
        })}
        <p className="reader-note">
          比分按 {record.teamA} : {record.teamB} 排列。
        </p>
      </section>
      <p className="reading-limit">
        以上解读依据本场分图与选手统计，不包含录像中的战术、经济或具体交火过程。同特工比较不代表两人直接对决。
      </p>
    </article>
  );
}
