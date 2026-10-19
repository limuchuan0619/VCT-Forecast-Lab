import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { analyzePostmatchR2, deepSeekModel } from '@/lib/deepseek';
import { buildAnalysisPacket, validateR2Analysis } from '@/lib/ai-reliability';
import {
  EDITORIAL_REVIEW_PROMPT,
  EDITORIAL_REVIEW_SCHEMA,
} from '@/lib/review-editorial';
import {
  ensurePostmatchAiJob,
  ensurePrematchAiJob,
  predictionById,
  refreshReaderReview,
} from '@/lib/prediction-store';

type AnalysisStage = 'prematch' | 'postmatch';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const body = (await request.json()) as {
      predictionId?: string;
      stage?: AnalysisStage;
      mode?: string;
    };
    if (!body.predictionId || !body.stage)
      throw new Error('missing_ai_retry_fields');
    if (!['prematch', 'postmatch'].includes(body.stage))
      throw new Error('invalid_ai_retry_stage');
    if (
      body.mode &&
      (!['reader_refresh', 'reader_preview'].includes(body.mode) ||
        body.stage !== 'postmatch')
    )
      throw new Error('invalid_ai_retry_mode');

    const prediction = await predictionById(env.DB, body.predictionId);
    if (!prediction)
      return NextResponse.json(
        { error: 'prediction_not_found' },
        { status: 404 },
      );
    if (body.stage === 'postmatch' && prediction.status !== 'resolved') {
      return NextResponse.json(
        { error: 'postmatch_requires_resolved_prediction' },
        { status: 409 },
      );
    }
    if (body.mode === 'reader_preview') {
      if (
        !env.DEEPSEEK_API_KEY ||
        !prediction.resultEvidence ||
        !prediction.scorecard
      )
        return NextResponse.json(
          { error: 'reader_preview_unavailable' },
          { status: 409 },
        );
      // Authenticated diagnostic only: never register/complete a job, write an
      // analysis, mutate a prediction, or put rejected prose on a public page.
      const packet = buildAnalysisPacket(prediction);
      const analyzed = await analyzePostmatchR2(
        env.DEEPSEEK_API_KEY,
        deepSeekModel(env),
        prediction,
        packet,
        {
          promptVersion: EDITORIAL_REVIEW_PROMPT,
          schemaVersion: EDITORIAL_REVIEW_SCHEMA,
        },
      );
      let validationError: string | null = null;
      try {
        validateR2Analysis(analyzed.output, packet);
      } catch (error) {
        validationError =
          error instanceof Error ? error.message : 'invalid_analysis';
      }
      return NextResponse.json({
        diagnosticOnly: true,
        persisted: false,
        validationError,
        output: analyzed.output,
        meta: analyzed.meta,
      });
    }

    // Post-match analysis is exclusively owned by the versioned job state machine.
    // This endpoint may register the unique logical job, but must never create a
    // second analysis record or bypass retry scheduling.
    if (body.stage === 'postmatch') {
      // Explicit owner-triggered, single-record format revision; old analyses
      // remain stored. Repeated requests resolve to the same logical job.
      const queued =
        body.mode === 'reader_refresh'
          ? await refreshReaderReview(env.DB, prediction, deepSeekModel(env))
          : await ensurePostmatchAiJob(env.DB, prediction, deepSeekModel(env));
      return NextResponse.json(
        {
          accepted: true,
          predictionId: prediction.id,
          stage: body.stage,
          ai: queued.created ? 'queued' : 'already_registered',
          jobStatus: queued.job.status,
        },
        { status: queued.job.status === 'SUCCESS' ? 200 : 202 },
      );
    }

    const queued = await ensurePrematchAiJob(
      env.DB,
      prediction,
      deepSeekModel(env),
    );
    return NextResponse.json(
      {
        accepted: true,
        predictionId: prediction.id,
        stage: body.stage,
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
