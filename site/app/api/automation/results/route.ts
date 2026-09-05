import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { analyzePostmatch, analyzePostmatchModelDiagnosis, deepSeekModel, MODEL_DIAGNOSIS_PROMPT_VERSION, POSTMATCH_PROMPT_VERSION } from '@/lib/deepseek';
import { challengerByChampion, failedAiAnalysisCount, latestAiAnalysisStatus, latestModelDiagnosisStatus, resolveChallenger, resolvePrediction, saveAiAnalysis, saveModelDiagnosis } from '@/lib/prediction-store';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = await request.json() as { predictionId?: string; actualWinner?: string; actualScore?: string; resolvedAt?: string };
    if (!body.predictionId || !body.actualWinner || !body.actualScore || !body.resolvedAt) throw new Error('missing_result_fields');
    const prediction = await resolvePrediction(env.DB, body.predictionId, body.actualWinner, body.actualScore, body.resolvedAt);
    const challenger = await resolveChallenger(env.DB, prediction, body.actualWinner, body.resolvedAt);
    const latestStatus = await latestAiAnalysisStatus(env.DB, prediction.id, 'postmatch');
    const diagnosisStatus = challenger ? await latestModelDiagnosisStatus(env.DB, challenger.id) : null;

    if (latestStatus === 'complete' && (!challenger || diagnosisStatus === 'complete')) return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'already_complete', diagnosis: diagnosisStatus });
    if (latestStatus === 'complete' && challenger) {
      if (!env.DEEPSEEK_API_KEY) {
        await saveModelDiagnosis(env.DB, { challenger, modelId: deepSeekModel(env), promptVersion: MODEL_DIAGNOSIS_PROMPT_VERSION, status: 'skipped', result: { actualWinner: body.actualWinner, actualScore: body.actualScore }, errorCode: 'deepseek_key_missing' });
        return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'already_complete', diagnosis: 'skipped_missing_key' }, { status: 202 });
      }
      try {
        const analyzed = await analyzePostmatchModelDiagnosis(env.DEEPSEEK_API_KEY, deepSeekModel(env), prediction, challenger);
        await saveModelDiagnosis(env.DB, { challenger, modelId: analyzed.modelId, promptVersion: analyzed.promptVersion, status: 'complete', result: { actualWinner: body.actualWinner, actualScore: body.actualScore }, output: analyzed.output });
        return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'already_complete', diagnosis: 'complete' });
      } catch (error) {
        const code = error instanceof Error ? error.message : 'deepseek_diagnosis_unknown_error';
        await saveModelDiagnosis(env.DB, { challenger, modelId: deepSeekModel(env), promptVersion: MODEL_DIAGNOSIS_PROMPT_VERSION, status: 'failed', result: { actualWinner: body.actualWinner, actualScore: body.actualScore }, errorCode: code });
        return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'already_complete', diagnosis: 'failed_non_blocking' }, { status: 202 });
      }
    }
    if (latestStatus === 'skipped') {
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'explicit_retry_required' }, { status: 202 });
    }
    if (latestStatus === 'failed'
      && await failedAiAnalysisCount(env.DB, prediction.id, 'postmatch', POSTMATCH_PROMPT_VERSION) >= 2) {
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'automatic_retry_limit_reached' }, { status: 202 });
    }

    if (!env.DEEPSEEK_API_KEY) {
      await saveAiAnalysis(env.DB, { predictionId: prediction.id, stage: 'postmatch', modelId: deepSeekModel(env), promptVersion: POSTMATCH_PROMPT_VERSION, status: 'skipped', errorCode: 'deepseek_key_missing' });
      if (challenger) await saveModelDiagnosis(env.DB, { challenger, modelId: deepSeekModel(env), promptVersion: MODEL_DIAGNOSIS_PROMPT_VERSION, status: 'skipped', result: { actualWinner: body.actualWinner, actualScore: body.actualScore }, errorCode: 'deepseek_key_missing' });
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'skipped_missing_key' }, { status: 202 });
    }

    try {
      const review = await analyzePostmatch(env.DEEPSEEK_API_KEY, deepSeekModel(env), prediction);
      await saveAiAnalysis(env.DB, { predictionId: prediction.id, stage: 'postmatch', modelId: review.modelId, promptVersion: review.promptVersion, status: 'complete', output: review.output });
      let diagnosis = 'not_available';
      if (challenger) {
        try {
          const analyzed = await analyzePostmatchModelDiagnosis(env.DEEPSEEK_API_KEY, deepSeekModel(env), prediction, challenger);
          await saveModelDiagnosis(env.DB, { challenger, modelId: analyzed.modelId, promptVersion: analyzed.promptVersion, status: 'complete', result: { actualWinner: body.actualWinner, actualScore: body.actualScore }, output: analyzed.output });
          diagnosis = 'complete';
        } catch (error) {
          const code = error instanceof Error ? error.message : 'deepseek_diagnosis_unknown_error';
          await saveModelDiagnosis(env.DB, { challenger, modelId: deepSeekModel(env), promptVersion: MODEL_DIAGNOSIS_PROMPT_VERSION, status: 'failed', result: { actualWinner: body.actualWinner, actualScore: body.actualScore }, errorCode: code });
          diagnosis = 'failed_non_blocking';
        }
      }
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'complete', diagnosis });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'deepseek_unknown_error';
      await saveAiAnalysis(env.DB, { predictionId: prediction.id, stage: 'postmatch', modelId: deepSeekModel(env), promptVersion: POSTMATCH_PROMPT_VERSION, status: 'failed', errorCode: code });
      const currentChallenger = challenger ?? await challengerByChampion(env.DB, prediction.id);
      if (currentChallenger) await saveModelDiagnosis(env.DB, { challenger: currentChallenger, modelId: deepSeekModel(env), promptVersion: MODEL_DIAGNOSIS_PROMPT_VERSION, status: 'failed', result: { actualWinner: body.actualWinner, actualScore: body.actualScore }, errorCode: code });
      return NextResponse.json({ accepted: true, predictionId: prediction.id, ai: 'failed', error: code }, { status: 202 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_request';
    const status = message === 'prediction_not_found' ? 404 : message.endsWith('_conflict') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
