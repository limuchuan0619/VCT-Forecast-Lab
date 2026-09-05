import { loadAutomationHealth } from '@/lib/prediction-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ ok: true, automation: await loadAutomationHealth() }, {
    headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=90' },
  });
}
