import { listPredictionRecords } from '@/lib/prediction-store';

export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({ ok: true, predictions: await listPredictionRecords(100) }, { headers: { 'cache-control': 'public, max-age=60' } });
}
