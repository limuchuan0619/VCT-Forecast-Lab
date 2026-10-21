import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { deepSeekModel } from '@/lib/deepseek';
import {
  ensurePrematchAiJob,
  latestAiAnalysisStatus,
  upsertPrediction,
  validatePrediction,
} from '@/lib/prediction-store';
import { validatedPrematchContext } from '@/lib/prematch-context';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY))
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = (await request.json()) as {
      prediction?: unknown;
      syncRunId?: string;
      prematchContext?: unknown;
    };
    const prediction = validatePrediction(body.prediction);
    if (body.syncRunId && body.syncRunId.length > 128)
      throw new Error('invalid_sync_run_id');
    await upsertPrediction(env.DB, prediction, body.syncRunId);
    const latestStatus = await latestAiAnalysisStatus(
      env.DB,
      prediction.id,
      'prematch',
    );

    if (latestStatus === 'complete')
      return NextResponse.json({
        accepted: true,
        predictionId: prediction.id,
        ai: 'already_complete',
      });
    if (
      prediction.status !== 'locked' ||
      Date.parse(prediction.scheduledAt) <= Date.now()
    ) {
      return NextResponse.json(
        {
          accepted: true,
          predictionId: prediction.id,
          ai: 'prematch_window_closed',
        },
        { status: 202 },
      );
    }
    const queued = await ensurePrematchAiJob(
      env.DB,
      prediction,
      deepSeekModel(env),
      validatedPrematchContext(body.prematchContext, prediction),
    );
    return NextResponse.json(
      {
        accepted: true,
        predictionId: prediction.id,
        ai: queued.created ? 'queued' : 'already_registered',
        jobStatus: queued.job.status,
      },
      { status: queued.job.status === 'SUCCESS' ? 200 : 202 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'invalid_request' },
      { status: 400 },
    );
  }
}
