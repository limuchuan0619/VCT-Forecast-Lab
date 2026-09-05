import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { analyzePrematch, deepSeekModel, PREMATCH_PROMPT_VERSION } from '@/lib/deepseek';
import { failedAiAnalysisCount, latestAiAnalysisStatus, saveAiAnalysis, upsertPrediction, validatePrediction } from '@/lib/prediction-store';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = await request.json() as { prediction?: unknown };
    const prediction = validatePrediction(body.prediction);
    await upsertPrediction(env.DB, prediction);
    const latestStatus = await latestAiAnalysisStatus(env.DB, prediction.id, 'prematch');

    if (latestStatus === 'complete') return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'already_complete' });
    if (latestStatus === 'skipped') {
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'explicit_retry_required' }, { status: 202 });
    }
    if (latestStatus === 'failed'
      && await failedAiAnalysisCount(env.DB, prediction.id, 'prematch', PREMATCH_PROMPT_VERSION) >= 2) {
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'automatic_retry_limit_reached' }, { status: 202 });
    }

    if (!env.DEEPSEEK_API_KEY) {
      await saveAiAnalysis(env.DB, { predictionId: prediction.id, stage: 'prematch', modelId: deepSeekModel(env), promptVersion: PREMATCH_PROMPT_VERSION, status: 'skipped', errorCode: 'deepseek_key_missing' });
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'skipped_missing_key' }, { status: 202 });
    }

    try {
      const analysis = await analyzePrematch(env.DEEPSEEK_API_KEY, deepSeekModel(env), prediction);
      await saveAiAnalysis(env.DB, { predictionId: prediction.id, stage: 'prematch', modelId: analysis.modelId, promptVersion: analysis.promptVersion, status: 'complete', output: analysis.output });
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'complete' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'deepseek_unknown_error';
      await saveAiAnalysis(env.DB, { predictionId: prediction.id, stage: 'prematch', modelId: deepSeekModel(env), promptVersion: PREMATCH_PROMPT_VERSION, status: 'failed', errorCode: code });
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'failed', error: code }, { status: 202 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid_request' }, { status: 400 });
  }
}
