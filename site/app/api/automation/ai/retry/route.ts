import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import {
  analyzePostmatch,
  analyzePrematch,
  deepSeekModel,
  POSTMATCH_PROMPT_VERSION,
  PREMATCH_PROMPT_VERSION,
} from '@/lib/deepseek';
import { latestAiAnalysisStatus, predictionById, saveAiAnalysis } from '@/lib/prediction-store';

type AnalysisStage = 'prematch' | 'postmatch';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as { predictionId?: string; stage?: AnalysisStage };
    if (!body.predictionId || !body.stage) throw new Error('missing_ai_retry_fields');
    if (!['prematch', 'postmatch'].includes(body.stage)) throw new Error('invalid_ai_retry_stage');

    const prediction = await predictionById(env.DB, body.predictionId);
    if (!prediction) return NextResponse.json({ error: 'prediction_not_found' }, { status: 404 });
    if (body.stage === 'postmatch' && prediction.status !== 'resolved') {
      return NextResponse.json({ error: 'postmatch_requires_resolved_prediction' }, { status: 409 });
    }

    const latestStatus = await latestAiAnalysisStatus(env.DB, prediction.id, body.stage);
    if (latestStatus === 'complete') {
      return NextResponse.json({ accepted: true, predictionId: prediction.id, stage: body.stage, ai: 'already_complete' });
    }

    const modelId = deepSeekModel(env);
    const promptVersion = body.stage === 'prematch' ? PREMATCH_PROMPT_VERSION : POSTMATCH_PROMPT_VERSION;
    if (!env.DEEPSEEK_API_KEY) {
      await saveAiAnalysis(env.DB, {
        predictionId: prediction.id,
        stage: body.stage,
        modelId,
        promptVersion,
        status: 'skipped',
        errorCode: 'deepseek_key_missing',
      });
      return NextResponse.json({ accepted: true, predictionId: prediction.id, stage: body.stage, ai: 'skipped_missing_key' }, { status: 202 });
    }

    try {
      const analysis = body.stage === 'prematch'
        ? await analyzePrematch(env.DEEPSEEK_API_KEY, modelId, prediction)
        : await analyzePostmatch(env.DEEPSEEK_API_KEY, modelId, prediction);
      await saveAiAnalysis(env.DB, {
        predictionId: prediction.id,
        stage: body.stage,
        modelId: analysis.modelId,
        promptVersion: analysis.promptVersion,
        status: 'complete',
        output: analysis.output,
      });
      return NextResponse.json({ accepted: true, predictionId: prediction.id, stage: body.stage, ai: 'complete' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'deepseek_unknown_error';
      await saveAiAnalysis(env.DB, {
        predictionId: prediction.id,
        stage: body.stage,
        modelId,
        promptVersion,
        status: 'failed',
        errorCode: code,
      });
      return NextResponse.json({ accepted: true, predictionId: prediction.id, stage: body.stage, ai: 'failed', error: code }, { status: 202 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid_request' }, { status: 400 });
  }
}
