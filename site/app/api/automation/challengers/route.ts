import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { upsertChallengerPrediction, validateChallengerPrediction } from '@/lib/prediction-store';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = await request.json() as { challenger?: unknown; syncRunId?: string };
    const challenger = validateChallengerPrediction(body.challenger);
    if (body.syncRunId && body.syncRunId.length > 128) throw new Error('invalid_sync_run_id');
    await upsertChallengerPrediction(env.DB, challenger, body.syncRunId);
    return NextResponse.json({ accepted: true, challengerId: challenger.id, status: challenger.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_request';
    return NextResponse.json({ error: message }, { status: message.endsWith('_conflict') ? 409 : 400 });
  }
}
