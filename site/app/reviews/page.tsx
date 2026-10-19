import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { MatchListCard } from '@/components/match-list-card';
import { predictionHistoryPage } from '@/lib/prediction-store';
import { historyPage } from '@/lib/history-query';
import { HistoryPagination } from '@/components/history-pagination';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '赛后复盘｜VCT Forecast Lab',
  description: '比赛结束后，比较赛前判断与真实结果，查看具体复盘。',
};
export default async function ReviewsPage({
  searchParams,
}: {
  searchParams?: Promise<{ page?: string }>;
}) {
  const query = await searchParams;
  const listing = await predictionHistoryPage(historyPage(query?.page), {
    resolvedOnly: true,
  })
    .then((result) => ({ ...result, unavailable: false }))
    .catch((error) => {
      console.error('Reviews unavailable', error);
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
      <SiteHeader active="reviews" />
      <main id="main" className="dashboard reader-dashboard">
        <section className="reader-heading">
          <div>
            <span className="reader-kicker">比赛结束，再看清楚</span>
            <h1>赛后复盘</h1>
            <p>看两队差在哪里，逐图了解选手表现与关键位置。</p>
          </div>
        </section>
        <div className="list-caption">
          <span>
            {listing.unavailable
              ? '记录暂时无法读取'
              : `共 ${listing.total} 场已结束比赛 · 本页 ${listing.records.length} 场`}
          </span>
          <span>赛后 AI 复盘完成后，自动显示在比赛详情</span>
        </div>
        <section className="history-list" aria-label="赛后复盘">
          {listing.records.map((record) => (
            <MatchListCard record={record} review compact key={record.id} />
          ))}
        </section>
        {!listing.unavailable && (
          <HistoryPagination
            page={listing.page}
            pages={listing.pages}
            base="/reviews"
          />
        )}
        {!listing.records.length && (
          <section className="reader-empty">
            <h2>
              {listing.unavailable ? '复盘暂时无法读取' : '等待第一场比赛结束'}
            </h2>
            <p>只展示结果已经确认的真实比赛。</p>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
