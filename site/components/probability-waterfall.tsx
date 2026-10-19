import type { PredictionRecord } from '@/lib/vct-types';
import { factorName, factorDescription } from '@/lib/presentation';

type WaterfallStep = {
  key: string;
  label: string;
  detail: string;
  start: number;
  end: number;
  delta: number;
};

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function ProbabilityWaterfall({ record }: { record: PredictionRecord }) {
  const factors = [...record.factors].sort((a, b) => a.rank - b.rank);
  if (factors.length === 0) return null;
  const waterfall = factors.reduce<{
    steps: WaterfallStep[];
    cumulative: number;
  }>(
    (state, factor) => {
      const end = state.cumulative + factor.probabilityPoints;
      return {
        cumulative: end,
        steps: [
          ...state.steps,
          {
            key: factor.key,
            label: factorName(factor.key, factor.label),
            detail: factorDescription(factor, record),
            start: state.cumulative,
            end,
            delta: factor.probabilityPoints,
          },
        ],
      };
    },
    { steps: [], cumulative: 50 },
  );
  const lockedFinal = record.teamAProbability * 100;
  const residual = lockedFinal - waterfall.cumulative;
  const steps =
    Math.abs(residual) >= 0.01
      ? [
          ...waterfall.steps,
          {
            key: 'rounding_residual',
            label: '精度校准',
            detail: '使展示值与锁定概率完全一致',
            start: waterfall.cumulative,
            end: lockedFinal,
            delta: residual,
          },
        ]
      : waterfall.steps;
  return (
    <section className="waterfall-panel" aria-labelledby="waterfall-title">
      <header className="section-heading">
        <div>
          <h2 id="waterfall-title">胜率如何形成</h2>
        </div>
        <p>
          从双方各50%开始，展示各因素带来的胜率变化。这里的顺序只是方便阅读，不代表模型的计算顺序，也不是比赛输赢的原因。
        </p>
      </header>
      <div className="waterfall-axis" aria-hidden="true">
        <span>0%</span>
        <span>50% 中性起点</span>
        <span>100%</span>
      </div>
      <div className="waterfall-table">
        <div className="waterfall-anchor">
          <span>00</span>
          <div>
            <strong>中性基线</strong>
            <small>双方先验机会相等</small>
          </div>
          <b>50.0%</b>
        </div>
        {steps.map((step, index) => {
          const left = clamp(Math.min(step.start, step.end));
          const width = Math.max(
            0.18,
            Math.abs(clamp(step.end) - clamp(step.start)),
          );
          return (
            <article className="waterfall-row" key={step.key}>
              <span className="waterfall-rank">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="waterfall-copy">
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </div>
              <div
                className="waterfall-track"
                aria-label={`${step.label} ${step.delta >= 0 ? '增加' : '减少'} ${Math.abs(step.delta).toFixed(2)} 个百分点，累计 ${step.end.toFixed(2)}%`}
              >
                <i className="midline" />
                <b
                  className={step.delta >= 0 ? 'gain' : 'loss'}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
                <em style={{ left: `${clamp(step.end)}%` }} />
              </div>
              <strong
                className={
                  step.delta >= 0
                    ? 'waterfall-delta positive-text'
                    : 'waterfall-delta negative-text'
                }
              >
                {step.delta >= 0 ? '+' : ''}
                {step.delta.toFixed(2)} 点
              </strong>
              <span className="waterfall-total">{step.end.toFixed(1)}%</span>
            </article>
          );
        })}
        <footer>
          <span>锁定结果</span>
          <strong>
            {record.teamA} {lockedFinal.toFixed(1)}%
          </strong>
          <small>
            {record.teamB} {(100 - lockedFinal).toFixed(1)}%
          </small>
        </footer>
      </div>
    </section>
  );
}
