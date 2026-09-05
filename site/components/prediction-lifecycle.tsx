import { CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react';
import type { PredictionRecord } from '@/lib/vct-types';
import { predictionLifecycle } from '@/lib/view-helpers';

export function PredictionLifecycle({ record }: { record: PredictionRecord }) {
  const lifecycle = predictionLifecycle(record);
  return (
    <section className="lifecycle-panel" aria-label={`预测生命周期：${lifecycle.label}`}>
      <header><span className="eyebrow">AUTOMATED LIFECYCLE</span><strong>{lifecycle.label}</strong></header>
      <ol>
        {lifecycle.steps.map((step, index) => (
          <li className={step.state} key={step.label}>
            <span className="lifecycle-icon" aria-hidden="true">
              {step.state === 'complete' ? <CircleCheck /> : step.state === 'current' ? <LoaderCircle /> : <CircleDashed />}
            </span>
            <i>{String(index + 1).padStart(2, '0')}</i>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}
