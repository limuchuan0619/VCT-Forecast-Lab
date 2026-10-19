import { env } from 'cloudflare:workers';
import { loadAiReliability, loadAutomationHealth, loadEvaluationIntegrity } from '@/lib/prediction-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [automation, evaluationIntegrity, aiReliability] = await Promise.all([
    loadAutomationHealth(), loadEvaluationIntegrity(env.DB), loadAiReliability(env.DB),
  ]);
  return Response.json({ ok: automation.status === 'healthy', runtimeOk: automation.status === 'healthy',
    metricsTrusted: evaluationIntegrity.status === 'TRUSTED', automation, evaluationIntegrity, aiReliability }, {
    headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=90' },
  });
}
