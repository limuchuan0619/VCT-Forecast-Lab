import {
  listPredictionRecords,
  predictionHistoryPage,
  predictionsForDay,
} from '@/lib/prediction-store';
import { historyPage } from '@/lib/history-query';
import { validDay } from '@/lib/presentation';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  if (query.has('date')) {
    const day = query.get('date')!;
    const region = query.get('region') ?? '';
    if (
      !validDay(day) ||
      (region &&
        !['CN', 'EMEA', 'AMERICAS', 'PACIFIC', 'INTERNATIONAL'].includes(
          region,
        ))
    )
      return Response.json(
        { ok: false, error: 'invalid_filter' },
        { status: 400 },
      );
    return Response.json(
      { ok: true, predictions: await predictionsForDay(day, region) },
      { headers: { 'cache-control': 'public, max-age=60' } },
    );
  }
  if (query.has('page')) {
    const result = await predictionHistoryPage(historyPage(query.get('page')));
    const { records, ...pagination } = result;
    return Response.json(
      { ok: true, predictions: records, pagination },
      { headers: { 'cache-control': 'public, max-age=60' } },
    );
  }
  // Preserve the existing no-parameter API contract for the Runner and clients.
  return Response.json(
    { ok: true, predictions: await listPredictionRecords(100) },
    { headers: { 'cache-control': 'public, max-age=60' } },
  );
}
