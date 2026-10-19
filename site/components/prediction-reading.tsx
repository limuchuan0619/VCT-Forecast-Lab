import type { PredictionRecord } from '@/lib/vct-types';
import { prematchReasons } from '@/lib/reader-analysis';
export function PredictionReading({ record }: { record: PredictionRecord }) {
  const reading = prematchReasons(record);
  return (
    <div className="reader-prose">
      {reading.reasons.length ? (
        reading.reasons.map((reason) => (
          <section className="plain-reason" key={reason.key}>
            <h3>{reason.title}</h3>
            <p>{reason.text}</p>
          </section>
        ))
      ) : (
        <p>这场没有保存足够的详细依据，暂时只能查看原来的胜率。</p>
      )}
      {reading.maps.length > 0 && (
        <section className="plain-reason">
          <h3>哪些地图值得留意？</h3>
          {reading.maps.map((text) => (
            <p key={text}>{text}</p>
          ))}
          <p className="reader-note">
            这是赛前对候选地图的判断，不代表本场一定会打这些地图。
          </p>
        </section>
      )}
      <p className="reader-note">{reading.limit}</p>
    </div>
  );
}
