import type { PredictionRecord } from '@/lib/vct-types';
import { evidenceItem } from '@/lib/evidence-presentation';

export function EvidenceReferences({
  record,
  references = [],
}: {
  record: PredictionRecord;
  references?: string[];
}) {
  const items = [...new Set(references)].map((ref) =>
    evidenceItem(record, ref),
  );
  return (
    <details className="evidence-reference">
      <summary>
        查看这段分析引用的证据{items.length ? `（${items.length}项）` : ''}
      </summary>
      {!items.length && (
        <p>
          这条旧记录没有保存可核查的证据引用，只保留原始说法，不当作已确认结论。
        </p>
      )}
      {items.map((item) => (
        <div className="evidence-item" key={item.reference}>
          <strong>{item.title}</strong>
          <span>
            {
              (
                {
                  prematch: '赛前保存',
                  postmatch: '赛后确认',
                  model: '系统核对',
                  missing: '尚未核验',
                } as const
              )[item.kind]
            }
          </span>
          <p>{item.text}</p>
          <small>原始引用：{item.reference}</small>
        </div>
      ))}
    </details>
  );
}
