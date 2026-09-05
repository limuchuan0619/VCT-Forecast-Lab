import { predictionRecordById } from '@/lib/prediction-store';

export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const prediction = await predictionRecordById(decodeURIComponent(id));
  return prediction
    ? Response.json({ ok: true, prediction }, { headers: { 'cache-control': 'public, max-age=60' } })
    : Response.json({ ok: false, error: 'prediction_not_found' }, { status: 404 });
}
