import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { MatchListCard } from '@/components/match-list-card';
import { predictionsForDay, loadPublicOverview } from '@/lib/prediction-store';
import {
  adjacentDay,
  chinaDay,
  tomorrowChinaDay,
  validDay,
} from '@/lib/presentation';
import { chinaTime, regionLabel } from '@/lib/view-helpers';
import { terminology } from '@/lib/terminology';

export const dynamic = 'force-dynamic';
type Props = { searchParams?: Promise<{ date?: string; region?: string }> };
export default async function Home({ searchParams }: Props) {
  const query = await searchParams;
  const today = chinaDay(Date.now()),
    tomorrow = tomorrowChinaDay();
  const day = validDay(query?.date) ? query!.date! : tomorrow;
  const region = [
    'CN',
    'EMEA',
    'AMERICAS',
    'PACIFIC',
    'INTERNATIONAL',
  ].includes(query?.region ?? '')
    ? query!.region!
    : '';
  const [overview, listing] = await Promise.all([
    loadPublicOverview(),
    predictionsForDay(day, region)
      .then((records) => ({ records, unavailable: false }))
      .catch((error) => {
        console.error('Public match list unavailable', error);
        return { records: [], unavailable: true };
      }),
  ]);
  const matches = listing.records;
  const href = (date: string, selectedRegion = region) =>
    `/?date=${date}${selectedRegion ? `&region=${selectedRegion}` : ''}`;
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <SiteHeader active="home" systemStatus={overview.automation.status} />
      <main id="main" className="dashboard reader-dashboard">
        <section className="reader-heading">
          <div>
            <span className="reader-kicker">VCT · 比赛预测</span>
            <h1>
              {day === tomorrow
                ? '明日比赛'
                : day === today
                  ? '今日比赛'
                  : '比赛预测'}
            </h1>
            <p>四赛区与国际赛 · 赛前判断，赛后检验</p>
          </div>
          <span className="reader-date">
            {day.replaceAll('-', '.')} · 北京时间
          </span>
        </section>
        {(listing.unavailable || overview.dataMode !== 'LIVE') && (
          <div className="boundary-note">
            <strong>实时预测暂时无法读取</strong>
            <p>请稍后重新打开页面。这里不会用演示比赛替代真实预测。</p>
          </div>
        )}
        <div className="schedule-toolbar">
          <nav className="reader-filters" aria-label="比赛日期">
            <a href={href(adjacentDay(day, -1))}>前一天</a>
            <a className={day === today ? 'selected' : ''} href={href(today)}>
              今天
            </a>
            <a
              className={day === tomorrow ? 'selected' : ''}
              href={href(tomorrow)}
            >
              明天
            </a>
            <a href={href(adjacentDay(day, 1))}>后一天</a>
          </nav>
          <form className="date-picker" action="/" method="get">
            <label htmlFor="match-date">比赛日期</label>
            <input
              id="match-date"
              type="date"
              name="date"
              defaultValue={day}
              required
            />
            {region && <input type="hidden" name="region" value={region} />}
            <button type="submit">查看</button>
          </form>
        </div>
        <nav className="reader-filters secondary-filters" aria-label="赛区筛选">
          <a className={!region ? 'selected' : ''} href={href(day, '')}>
            全部赛区
          </a>
          {['CN', 'EMEA', 'AMERICAS', 'PACIFIC', 'INTERNATIONAL'].map((r) => (
            <a
              key={r}
              className={r === region ? 'selected' : ''}
              href={href(day, r)}
            >
              {regionLabel(r)}
            </a>
          ))}
        </nav>
        <div className="list-caption">
          <span>
            {listing.unavailable
              ? '比赛列表暂时无法读取'
              : `${matches.length} 场已生成预测`}
          </span>
          <span>只有满足数据要求的比赛才会出现</span>
        </div>
        <section className="match-list-grid" aria-label="当日预测比赛">
          {matches.map((record, index) => (
            <MatchListCard
              key={record.id}
              record={record}
              featured={index === 0}
            />
          ))}
        </section>
        {!matches.length && !listing.unavailable && (
          <section className="reader-empty">
            <h2>
              {day === tomorrow
                ? '明日暂无已生成的预测'
                : '这一天暂无已生成的预测'}
            </h2>
            <p>云端会继续检查赛程。可以切换日期，或查看已经保存的预测历史。</p>
            <a href="/predictions">查看预测历史</a>
          </section>
        )}
        <details
          id="update-status"
          className="reader-disclosure runtime-disclosure"
        >
          <summary>
            数据更新于{' '}
            {overview.automation.lastSuccessfulSyncAt
              ? chinaTime(overview.automation.lastSuccessfulSyncAt)
              : '等待同步'}{' '}
            · {terminology('automation', overview.automation.status).label}
          </summary>
          <p>
            云端每两小时检查赛程和赛果，不需要你的电脑保持开启，也不会让网页持续自动刷新。
          </p>
          <p>
            等待结果 {overview.automation.pendingResults} 场 · 等待复盘{' '}
            {overview.automation.pendingReviews}{' '}
            场。预测一旦在赛前保存，之后不会根据赛果改写。
          </p>
        </details>
      </main>
      <SiteFooter />
    </div>
  );
}
