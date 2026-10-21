import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import {
  listModelComparisonRecords,
  loadPublicOverview,
} from '@/lib/prediction-store';
import {
  evaluateModels,
  modelNames,
  modelProbabilities,
  resultSentence,
  comparisonCoverage,
  largestDisagreements,
} from '@/lib/presentation';
import type { ComparisonModel } from '@/lib/presentation';
import { percent } from '@/lib/view-helpers';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '模型实验室｜VCT Forecast Lab',
  description: '用相同比赛检验系统预测、试验预测和AI参考的长期表现。',
};
export default async function ModelsPage({
  searchParams,
}: {
  searchParams?: Promise<{ scope?: string }>;
}) {
  const scope = (await searchParams)?.scope ?? 'all';
  const groups: Record<string, ComparisonModel[]> = {
    all: ['champion', 'c1', 'deepseek'],
    'champion-c1': ['champion', 'c1'],
    'champion-deepseek': ['champion', 'deepseek'],
    'c1-deepseek': ['c1', 'deepseek'],
  };
  const models = groups[scope] ?? groups.all;
  const [overview, listing] = await Promise.all([
    loadPublicOverview(),
    listModelComparisonRecords()
      .then((records) => ({ records, unavailable: false }))
      .catch(() => ({ records: [], unavailable: true })),
  ]);
  const evaluation = evaluateModels(listing.records, models);
  const show =
    !listing.unavailable &&
    (!models.includes('c1') ||
      overview.evaluationIntegrity?.status === 'TRUSTED');
  const coverage = comparisonCoverage(listing.records, models);
  const gaps = show ? largestDisagreements(listing.records, models) : [];
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <SiteHeader active="matches" />
      <main id="main" className="dashboard reader-dashboard">
        <section className="reader-heading">
          <div>
            <span className="reader-kicker">把每次判断交给比赛检验</span>
            <h1>模型实验室</h1>
            <p>不只看猜中一场，更看长期给出的胜率是否靠谱。</p>
          </div>
        </section>
        <p className="reader-note">
          系统预测用于网站正式胜率；试验预测只作观察。AI 参考由 DeepSeek
          提供，它能看到系统预测，不是完全独立的判断。
        </p>
        <section className="detail-section">
          <h2>同样的比赛，谁判断得更好？</h2>
          <nav className="reader-filters" aria-label="选择比较范围">
            {Object.entries(groups).map(([key, values]) => (
              <a
                key={key}
                className={values.join() === models.join() ? 'selected' : ''}
                href={`/matches?scope=${key}`}
              >
                {key === 'all'
                  ? '三方都有记录'
                  : values.map((model) => modelNames[model]).join('与')}
              </a>
            ))}
          </nav>
          <p className="reader-note">
            {show
              ? `共同预测且已结束：${evaluation.matches} 场。只计算开赛前保存的有效判断。`
              : '成绩暂时无法完整核验，先不显示比较数字。'}
          </p>
          {show && evaluation.matches > 0 ? (
            <div className="reader-table-wrap compact-comparison">
              <table className="reader-table">
                <caption className="sr-only">相同比赛上的预测表现</caption>
                <thead>
                  <tr>
                    <th>预测方式</th>
                    <th>检验场次</th>
                    <th>
                      胜者命中率 <small>Accuracy</small>
                    </th>
                    <th>
                      胜率偏差 <small>Brier Score ↓</small>
                    </th>
                    <th>
                      错误代价 <small>Log Loss ↓</small>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => {
                    const m = evaluation.metrics[model]!;
                    return (
                      <tr key={model}>
                        <th scope="row">{modelNames[model]}</th>
                        <td>{m.matches} 场</td>
                        <td>{percent(m.accuracy)}</td>
                        <td>{m.brier.toFixed(4)}</td>
                        <td>{m.logLoss.toFixed(4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            show && <p>还没有可以共同比较的已结束比赛。</p>
          )}
          <p className="reader-note">
            命中率越高越好；胜率偏差和错误代价越低越好，后者对“很有把握却猜错”的判断扣分更多。
          </p>
          <p className="reader-note">
            系统预测为 Champion V1.0.0，试验预测为冻结的 Logistic C1。Elo
            目前只有历史离线评估，没有可核验的真实赛前对照记录，因此不并入这张实时成绩表。
          </p>
          <p className="reader-note">
            目前仍在积累样本，暂不评选最优预测方式，也不替换系统模型。试验预测已完成{' '}
            {overview.challenger?.eligibleResolvedMatches ?? '—'} / 100
            场真实比赛观察；达到场次要求也不代表自动启用。
          </p>
          {show && evaluation.matches > 0 && (
            <details className="reader-disclosure">
              <summary>给出的胜率，和真实结果接近吗？</summary>
              <p>
                例如，长期被判断为六成胜率的队伍，实际是否大约赢了六成？下面按每场第一支队伍的胜率分组。场次少时，结果容易波动，不能急着下结论。
              </p>
              {models.map((model) => (
                <section className="plain-reason" key={model}>
                  <h3>{modelNames[model]}</h3>
                  <div className="reader-table-wrap">
                    <table className="reader-table">
                      <thead>
                        <tr>
                          <th>预计胜率</th>
                          <th>场次</th>
                          <th>平均判断</th>
                          <th>实际获胜</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evaluation.metrics[model]!.bins.map((bin, i) =>
                          bin.count > 0 ? (
                            <tr key={i}>
                              <td>
                                {i * 10}%–{(i + 1) * 10}%
                              </td>
                              <td>{bin.count}</td>
                              <td>
                                {bin.probability === null
                                  ? '—'
                                  : percent(bin.probability)}
                              </td>
                              <td>
                                {bin.winRate === null
                                  ? '—'
                                  : percent(bin.winRate)}
                              </td>
                            </tr>
                          ) : null,
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </details>
          )}
          {!listing.unavailable && (
            <details className="reader-disclosure">
              <summary>哪些比赛没有计入？</summary>
              <p>
                网站共有 {coverage.total} 条系统预测，{coverage.pending}{' '}
                场尚未结束。
                {show
                  ? `当前有 ${coverage.eligible} 场符合这组比较要求。`
                  : '目前不能完整核验比较成绩。'}
              </p>
              <ul>
                {models.map((model) => (
                  <li key={model}>
                    {modelNames[model]}：{coverage.missing[model]}{' '}
                    条已结束记录缺少合格的赛前判断。
                  </li>
                ))}
              </ul>
              <p>
                缺失原因可能重叠。历史测试、模拟比赛和赛后补写的判断不计入；不同范围的场次不能混在一起比较。
              </p>
            </details>
          )}
        </section>
        {!!gaps.length && (
          <section className="detail-section">
            <h2>哪些比赛分歧最大？</h2>
            <p className="reader-note">
              从当前共同比赛中选出三场，只帮助理解分歧，不用它们代替全部成绩。
            </p>
            {gaps.map(({ record, gap }) => (
              <article className="comparison-match" key={record.id}>
                <h3>
                  <a href={`/predictions/${encodeURIComponent(record.id)}`}>
                    {record.teamA} 对阵 {record.teamB} ↗
                  </a>
                </h3>
                <p>
                  针对 {record.teamA} 的胜率：
                  {models
                    .map(
                      (model) =>
                        `${modelNames[model]} ${percent(modelProbabilities(record)[model]!)}`,
                    )
                    .join('；')}
                  。
                </p>
                <p className="reader-note">
                  最大相差 {(gap * 100).toFixed(1)} 个百分点 ·{' '}
                  {resultSentence(record)}
                </p>
              </article>
            ))}
          </section>
        )}
        <details className="reader-disclosure">
          <summary>查看最近比赛的原预测</summary>
          <p className="reader-note">
            这里只列最近 20
            场；上方成绩使用全部符合要求的记录。所有胜率均针对每行的第一支队伍。
          </p>
          <div className="reader-table-wrap">
            <table className="reader-table">
              <thead>
                <tr>
                  <th>比赛</th>
                  <th>系统预测</th>
                  <th>试验预测</th>
                  <th>AI 参考</th>
                </tr>
              </thead>
              <tbody>
                {listing.records.slice(0, 20).map((record) => (
                  <tr key={record.id}>
                    <th scope="row">
                      <a href={`/predictions/${encodeURIComponent(record.id)}`}>
                        {record.teamA} 对阵 {record.teamB}
                      </a>
                    </th>
                    {(['champion', 'c1', 'deepseek'] as const).map((model) => {
                      const p = modelProbabilities(record)[model];
                      return (
                        <td key={model}>
                          {p === null ? '无赛前记录' : percent(p)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </main>
      <SiteFooter />
    </div>
  );
}
