import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { finishPublicSync, startPublicSync } from '@/lib/prediction-store';

type SyncRunInput = {
  syncRunId?: string;
  runnerRunId?: string | null;
  status?: 'RUNNING' | 'SUCCESS' | 'DEGRADED' | 'FAILED';
  startedAt?: string;
  completedAt?: string;
  counters?: Record<string, unknown>;
  failures?: Array<{ type: string; id: string; error: string }>;
  errorCode?: string | null;
};

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json() as SyncRunInput;
    if (!body.syncRunId || !body.status || !body.startedAt) throw new Error('missing_sync_run_fields');
    if (body.syncRunId.length > 128 || body.runnerRunId && body.runnerRunId.length > 128) throw new Error('invalid_sync_run_id');
    if (body.status === 'RUNNING') {
      await startPublicSync(env.DB, {
        id: body.syncRunId,
        runnerRunId: body.runnerRunId,
        startedAt: body.startedAt,
      });
    } else {
      if (!body.completedAt || !body.counters || !Array.isArray(body.failures)) throw new Error('missing_sync_completion_fields');
      await finishPublicSync(env.DB, {
        id: body.syncRunId,
        status: body.status,
        completedAt: body.completedAt,
        counters: body.counters,
        failures: body.failures.slice(0, 200).map((item) => ({
          type: String(item.type).slice(0, 64), id: String(item.id).slice(0, 256), error: String(item.error).slice(0, 512),
        })),
        errorCode: body.errorCode?.slice(0, 512) ?? null,
      });
    }
    return NextResponse.json({ accepted: true, syncRunId: body.syncRunId, status: body.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_request';
    return NextResponse.json({ error: message }, { status: message.endsWith('_conflict') ? 409 : 400 });
  }
}
