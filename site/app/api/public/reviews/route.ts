import { listPostmatchReviewRecords } from '@/lib/prediction-store';

export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({ ok: true, reviews: await listPostmatchReviewRecords(100) }, { headers: { 'cache-control': 'public, max-age=60' } });
}
