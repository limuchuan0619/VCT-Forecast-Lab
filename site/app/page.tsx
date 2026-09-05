import {
  Activity,
  ArrowUpRight,
  BrainCircuit,
  Clock3,
  CloudCog,
  Database,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { loadPublicOverview } from '@/lib/prediction-store';
import { chinaTime, intervalLabel } from '@/lib/view-helpers';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const overview = await loadPublicOverview();
  const prediction = overview.prediction;
  const probabilityA = prediction.teamAProbability * 100;
  const probabilityB = 100 - probabilityA;
  const factors = [...prediction.factors].sort((a, b) => a.rank - b.rank).slice(0, 7);
  const maxFactor = Math.max(...factors.map((factor) => Math.abs(factor.probabilityPoints)), 0.01);
  const aiAvailable = overview.ai.status === 'available' && overview.ai.analysis;
  const automation = overview.automation;
  const learningProgress = Math.min(100, overview.learning.trainingGate > 0
    ? overview.learning.trainingEligible / overview.learning.trainingGate * 100 : 0);
  const healthLabel = automation.status === 'healthy' ? '运行正常'
    : automation.status === 'stale' ? '同步延迟'
      : automation.status === 'degraded' ? '部分异常'
        : '等待运行';
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">跳到主要内容</a>
      <SiteHeader active="home" aiConfigured={overview.ai.configured} systemStatus={automation.status} />

      <main id="main" className="dashboard">
        <section className="intro" aria-labelledby="page-title">
          <div>
            <Badge variant="outline" className="version-badge">V1.3.02 · PROSPECTIVE LEARNING</Badge>
            <h1 id="page-title">预测不是答案，<br />而是一条可验证的推理链。</h1>
          </div>
          <p>赛前锁定概率与每个变量，赛后只追加结果。DeepSeek 负责分析与提出假设，治理引擎决定候选版本能否晋级。</p>
        </section>

        <section className={`automation-health ${automation.status}`} aria-label="云端自动化健康状态">
          <header>
            <span className="health-icon"><CloudCog /></span>
            <div><span className="eyebrow">CLOUD AUTOMATION</span><h2>{healthLabel}</h2></div>
            <p>{intervalLabel(automation.intervalSeconds)}自动检查未来 {automation.horizonHours} 小时赛程；网页不会在你的电脑上持续刷新。</p>
          </header>
          <div><RefreshCw /><span>最近完成</span><strong>{automation.lastRunCompletedAt ? chinaTime(automation.lastRunCompletedAt) : '等待首次运行'}</strong><small>{automation.lastRunStatus ?? '暂无状态'}</small></div>
          <div><Clock3 /><span>预计下次</span><strong>{automation.nextExpectedAt ? chinaTime(automation.nextExpectedAt) : '等待排期'}</strong><small>由云端调度，不依赖本机</small></div>
          <div><LockKeyhole /><span>等待赛果</span><strong>{automation.pendingResults}</strong><small>仅系统正式预测</small></div>
          <div><BrainCircuit /><span>等待复盘</span><strong>{automation.pendingReviews}</strong><small>旧人工档案不计入</small></div>
        </section>

        <section id="prediction" className="prediction-grid" aria-labelledby="prediction-title">
          <article className="match-card">
            <header className="panel-heading">
              <div>
                <span className="eyebrow">最近一次系统自动预测 · {prediction.status === 'resolved' ? '已结算' : '已锁定'}</span>
                <h2 id="prediction-title">{prediction.teamA} <i>vs</i> {prediction.teamB}</h2>
              </div>
              <Badge className="locked-badge"><LockKeyhole />赛前已锁定</Badge>
            </header>

            <div className="probability-stage">
              <div className="team team-a"><span>{prediction.teamA}</span><strong>{probabilityA.toFixed(1)}<sup>%</sup></strong><small>{probabilityA >= probabilityB ? '模型选择' : '模型不看好'}</small></div>
              <div className="versus"><span>预测比分</span><strong>{prediction.predictedScore.replace('-', '—')}</strong><small>{prediction.event}</small></div>
              <div className="team team-b"><span>{prediction.teamB}</span><strong>{probabilityB.toFixed(1)}<sup>%</sup></strong><small>{probabilityB > probabilityA ? '模型选择' : '模型不看好'}</small></div>
            </div>

            <div className="probability-line" aria-label={`${prediction.teamA} ${probabilityA.toFixed(1)}%，${prediction.teamB} ${probabilityB.toFixed(1)}%`}><span style={{ width: `${probabilityA}%` }} /></div>

            <div className="map-row">
              {prediction.maps.map((map) => (
                <div key={map.map}>
                  <span>{map.map}</span>
                  <strong>{(map.teamAProbability * 100).toFixed(1)}<small>%</small></strong>
                  <i><b style={{ width: `${map.teamAProbability * 100}%` }} /></i>
                  <small>{prediction.teamB} {(map.teamBProbability * 100).toFixed(1)}%</small>
                </div>
              ))}
            </div>

            <footer className="evidence-line">
              <span>数据截止 {new Date(prediction.dataCutoffAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
              <span>来源 {prediction.evidence.sourceLabel}</span>
              <span>Patch {prediction.evidence.patchProvenance}</span>
            </footer>
          </article>

          <aside className="ai-panel" aria-labelledby="ai-title">
            <div className="ai-orbit" aria-hidden="true"><BrainCircuit /></div>
            <span className="eyebrow">认知分析层</span>
            <h2 id="ai-title">{aiAvailable ? 'DeepSeek 已完成影子分析，' : 'DeepSeek 已预留，'}<br />始终不直接控制正式概率。</h2>
            <p>{aiAvailable ? overview.ai.analysis?.summary : '接入密钥后，它只读取赛前快照，输出结构化分析、风险和候选假设。它不能覆盖预测，也不能直接修改线上权重。'}</p>
            <dl>
              <div><dt>运行模式</dt><dd>{overview.ai.status === 'available' ? '影子分析完成' : '影子分析'}</dd></div>
              <div><dt>数据库权限</dt><dd>只读证据</dd></div>
              <div><dt>晋级权限</dt><dd>禁止</dd></div>
            </dl>
            <a href="#governance">查看安全边界 <ArrowUpRight /></a>
          </aside>
        </section>

        <section id="factors" className="factor-section" aria-labelledby="factor-title">
          <header className="section-heading">
            <div><span className="eyebrow">EXACT SHAPLEY · 概率点</span><h2 id="factor-title">这一场，哪些变量改变了判断</h2></div>
            <p>向右支持 {prediction.teamA}，向左支持 {prediction.teamB}。绝对占比衡量影响规模，正负贡献允许互相抵消。</p>
          </header>
          <div className="factor-table">
            <div className="factor-axis" aria-hidden="true"><span>支持 {prediction.teamB}</span><i>0</i><span>支持 {prediction.teamA}</span></div>
            {factors.map((factor) => {
              const width = Math.max(2, Math.abs(factor.probabilityPoints) / maxFactor * 48);
              return (
                <article key={factor.key} className="factor-row">
                  <span className="factor-rank">{String(factor.rank).padStart(2, '0')}</span>
                  <div className="factor-copy"><strong>{factor.label}</strong><small>{factor.detail}</small></div>
                  <div className="factor-plot" aria-label={`${factor.label} ${factor.probabilityPoints > 0 ? `支持 ${prediction.teamA}` : `支持 ${prediction.teamB}`} ${Math.abs(factor.probabilityPoints).toFixed(2)} 个百分点`}>
                    <i className="zero" />
                    <b className={factor.probabilityPoints > 0 ? 'positive' : 'negative'} style={{ width: `${width}%` }} />
                  </div>
                  <strong className={factor.probabilityPoints > 0 ? 'factor-value positive-text' : 'factor-value negative-text'}>{factor.probabilityPoints > 0 ? '+' : ''}{factor.probabilityPoints.toFixed(2)}pp</strong>
                  <span className="factor-share">{(factor.absoluteShare * 100).toFixed(1)}%</span>
                </article>
              );
            })}
          </div>
        </section>

        <section className="learning-section" aria-labelledby="learning-title">
          <header className="section-heading">
            <div><span className="eyebrow">PROSPECTIVE GOLD DATASET</span><h2 id="learning-title">从网站上线后，按当时真实可见信息学习</h2></div>
            <p>所有发现的赛程都会在后台留下只追加快照，包括因数据不足而未预测的比赛；公开页面仍只呈现正式系统预测。</p>
          </header>
          <div className="learning-grid">
            <article><span>赛前快照</span><strong>{overview.learning.snapshots}</strong><small>{overview.learning.fixtures} 场独立赛程</small></article>
            <article><span>可预测 / 被阻断</span><strong>{overview.learning.ready} / {overview.learning.blocked}</strong><small>阻断样本也保留，用于发现覆盖盲区</small></article>
            <article><span>已取得赛果</span><strong>{overview.learning.labeled}</strong><small>{overview.learning.pending} 个样本等待标签</small></article>
            <article className="learning-gate"><span>首轮训练门槛</span><strong>{overview.learning.trainingEligible} / {overview.learning.trainingGate}</strong><i><b style={{ width: `${learningProgress}%` }} /></i><small>达到门槛后才允许创建 Challenger 回测</small></article>
          </div>
        </section>

        <section id="governance" className="governance-section" aria-labelledby="governance-title">
          <header className="section-heading">
            <div><span className="eyebrow">CHAMPION → CHALLENGER</span><h2 id="governance-title">自动学习，但不允许自由改写自己</h2></div>
            <Badge variant="outline" className="freeze-badge">{overview.governance.globalWeightsFrozen ? '全局权重冻结' : '受控晋级开启'}</Badge>
          </header>
          <div className="governance-flow">
            <article><span>01</span><Activity /><h3>结果进入</h3><p>只追加赛后结果，不覆盖赛前快照。</p></article>
            <article><span>02</span><BrainCircuit /><h3>提出假设</h3><p>DeepSeek 只能输出候选实验 JSON。</p></article>
            <article><span>03</span><Database /><h3>时间回测</h3><p>按当时可见数据重新计算全部比赛。</p></article>
            <article><span>04</span><LockKeyhole /><h3>晋级或拒绝</h3><p>Brier、Log Loss 与赛区稳定性共同裁决。</p></article>
          </div>
        </section>

        <section id="data" className="data-strip" aria-label="数据概况">
          <div><span>历史基线比赛</span><strong>{overview.data.matches.toLocaleString('zh-CN')}</strong><small>仅用于低权重初始化</small></div>
          <div><span>队伍档案</span><strong>{overview.data.teams}</strong><small>{overview.data.regions} 大赛区</small></div>
          <div><span>系统赛前预测</span><strong>{overview.data.predictions}</strong><small>人工档案不计入</small></div>
          <div><span>数据来源</span><strong>VLR</strong><small>社区二级来源</small></div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
