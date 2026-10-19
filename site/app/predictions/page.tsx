import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { MatchListCard } from '@/components/match-list-card';
import { predictionHistoryPage } from '@/lib/prediction-store';
import { historyPage } from '@/lib/history-query';
import { HistoryPagination } from '@/components/history-pagination';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '预测历史｜VCT Forecast Lab',
  description: '查看已保存的赛前预测，点击比赛了解当时的判断依据。',
};
export default async function PredictionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ page?: string }>;
}) {
  const query = await searchParams;
  const listing = await predictionHistoryPage(historyPage(query?.page))
    .then((result) => ({ ...result, unavailable: false }))
    .catch((error) => {
      console.error('Prediction history unavailable', error);
      return {
        records: [],
        page: 1,
        pages: 1,
        total: 0,
        pageSize: 20,
        unavailable: true,
      };
    });
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <SiteHeader active="predictions" />
      <main id="main" className="dashboard reader-dashboard">
        <section className="reader-heading">
          <div>
            <span className="reader-kicker">当时的判断，不事后改写</span>
            <h1>预测历史</h1>
            <p>点击比赛，查看赛前胜率、影响因素和地图分析。</p>
          </div>
        </section>
        <div className="list-caption">
          <span>
            {listing.unavailable
              ? '记录暂时无法读取'
              : `共 ${listing.total} 场预测 · 本页 ${listing.records.length} 场`}
          </span>
          <span>赛前 AI 分析与赛后结果分别保存</span>
        </div>
        <section className="history-list" aria-label="预测历史">
          {listing.records.map((record) => (
            <MatchListCard record={record} compact key={record.id} />
          ))}
        </section>
        {!listing.unavailable && (
          <HistoryPagination
            page={listing.page}
            pages={listing.pages}
            base="/predictions"
          />
        )}
        {!listing.records.length && (
          <section className="reader-empty">
            <h2>
              {listing.unavailable ? '预测历史暂时无法读取' : '还没有预测记录'}
            </h2>
            <p>
              {listing.unavailable
                ? '请稍后重新打开页面，不使用演示比赛替代真实记录。'
                : '符合条件的比赛完成自动预测后，会出现在这里。'}
            </p>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
