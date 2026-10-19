import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { deepSeekModel } from '@/lib/deepseek';
import { ensureDiagnosisAiJob, ensurePostmatchAiJob, resolveChallenger, resolvePrediction } from '@/lib/prediction-store';
import type { ResultEvidenceEnvelope } from '@/lib/vct-types';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = await request.json() as { predictionId?: string; actualWinner?: string; actualScore?: string; resolvedAt?: string; resultEvidence?: ResultEvidenceEnvelope; syncRunId?: string };
    if (!body.predictionId || !body.actualWinner || !body.actualScore || !body.resolvedAt || !body.resultEvidence) throw new Error('missing_result_fields');
    if (body.syncRunId && body.syncRunId.length > 128) throw new Error('invalid_sync_run_id');
    const prediction = await resolvePrediction(env.DB, body.predictionId, body.actualWinner, body.actualScore, body.resolvedAt, body.resultEvidence, body.syncRunId);
    const challenger = await resolveChallenger(env.DB, prediction, body.actualWinner, body.resolvedAt, body.syncRunId);
    const queued = await ensurePostmatchAiJob(env.DB, prediction, deepSeekModel(env));
    // Result evidence and scorecards commit before any provider work. The worker
    // owns diagnosis generation/retries, never this settlement response.
    let diagnosis = challenger ? 'PENDING' : 'not_applicable';
    try {
      if (challenger) diagnosis = (await ensureDiagnosisAiJob(env.DB, prediction, challenger, deepSeekModel(env))).status;
    } catch { diagnosis = 'reconciliation_pending'; }
    return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: queued.job.status, diagnosis }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_request';
    const status = message === 'prediction_not_found' ? 404 : message.endsWith('_conflict') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
