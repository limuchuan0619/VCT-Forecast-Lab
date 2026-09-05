import type { PredictionRecord } from '@/lib/vct-types';

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
  const waterfall = factors.reduce<{ steps: WaterfallStep[]; cumulative: number }>((state, factor) => {
    const end = state.cumulative + factor.probabilityPoints;
    return {
      cumulative: end,
      steps: [...state.steps, { key: factor.key, label: factor.label, detail: factor.detail, start: state.cumulative, end, delta: factor.probabilityPoints }],
    };
  }, { steps: [], cumulative: 50 });
  const lockedFinal = record.teamAProbability * 100;
  const residual = lockedFinal - waterfall.cumulative;
  const steps = Math.abs(residual) >= 0.01
    ? [...waterfall.steps, { key: 'rounding_residual', label: '精度校准', detail: '使展示值与锁定概率完全一致', start: waterfall.cumulative, end: lockedFinal, delta: residual }]
    : waterfall.steps;
  return (
    <section className="waterfall-panel" aria-labelledby="waterfall-title">
      <header className="section-heading">
        <div><span className="eyebrow">PROBABILITY WATERFALL</span><h2 id="waterfall-title">概率如何从 50% 走到最终值</h2></div>
        <p>按影响排名累加精确 Shapley 概率点。Shapley 贡献可交换，排列顺序只用于阅读，不代表模型按此先后计算。</p>
      </header>
      <div className="waterfall-axis" aria-hidden="true"><span>0%</span><span>50% 中性起点</span><span>100%</span></div>
      <div className="waterfall-table">
        <div className="waterfall-anchor"><span>00</span><div><strong>中性基线</strong><small>双方先验机会相等</small></div><b>50.0%</b></div>
        {steps.map((step, index) => {
          const left = clamp(Math.min(step.start, step.end));
          const width = Math.max(.18, Math.abs(clamp(step.end) - clamp(step.start)));
          return (
            <article className="waterfall-row" key={step.key}>
              <span className="waterfall-rank">{String(index + 1).padStart(2, '0')}</span>
              <div className="waterfall-copy"><strong>{step.label}</strong><small>{step.detail}</small></div>
              <div className="waterfall-track" aria-label={`${step.label} ${step.delta >= 0 ? '增加' : '减少'} ${Math.abs(step.delta).toFixed(2)} 个百分点，累计 ${step.end.toFixed(2)}%`}>
                <i className="midline" />
                <b className={step.delta >= 0 ? 'gain' : 'loss'} style={{ left: `${left}%`, width: `${width}%` }} />
                <em style={{ left: `${clamp(step.end)}%` }} />
              </div>
              <strong className={step.delta >= 0 ? 'waterfall-delta positive-text' : 'waterfall-delta negative-text'}>{step.delta >= 0 ? '+' : ''}{step.delta.toFixed(2)}pp</strong>
              <span className="waterfall-total">{step.end.toFixed(1)}%</span>
            </article>
          );
        })}
        <footer><span>锁定结果</span><strong>{record.teamA} {lockedFinal.toFixed(1)}%</strong><small>{record.teamB} {(100 - lockedFinal).toFixed(1)}%</small></footer>
      </div>
    </section>
  );
}
