import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { POSTMATCH_JOB_PROMPT_VERSION } from '@/lib/ai-reliability';
import { deepSeekModel } from '@/lib/deepseek';
import { correctPredictionResult, correctResolvedChallenger, ensurePostmatchAiJob } from '@/lib/prediction-store';
import type { ResultEvidenceEnvelope } from '@/lib/vct-types';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = await request.json() as {
      predictionId?: string; actualWinner?: string; actualScore?: string; resolvedAt?: string;
      resultEvidence?: ResultEvidenceEnvelope; reason?: 'SOURCE_PAGE_STABILIZED_AFTER_PREMATURE_CAPTURE';
    };
    if (!body.predictionId || !body.actualWinner || !body.actualScore || !body.resolvedAt || !body.resultEvidence || !body.reason) {
      throw new Error('missing_result_correction_fields');
    }
    const corrected = await correctPredictionResult(
      env.DB, body.predictionId, body.actualWinner, body.actualScore, body.resolvedAt, body.resultEvidence, body.reason,
    );
    await correctResolvedChallenger(env.DB, corrected.prediction, body.actualWinner, body.resolvedAt);
    const queued = await ensurePostmatchAiJob(env.DB, corrected.prediction, deepSeekModel(env), {
      promptVersion: `${POSTMATCH_JOB_PROMPT_VERSION}-result-revision-${corrected.revisionNo}`,
    });
    return NextResponse.json({ accepted: true, predictionId: corrected.prediction.id, revisionNo: corrected.revisionNo, ai: queued.job.status }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_request';
    const status = message === 'prediction_not_found' ? 404 : message.endsWith('_conflict') || message.endsWith('_complete') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
