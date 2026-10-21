import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import {
  classifyAiFailure,
  validatePrematchAnalysis,
  validateR2Analysis,
} from '@/lib/ai-reliability';
import {
  analyzePostmatchModelDiagnosis,
  analyzePostmatchR2,
  analyzePrematch,
  deepSeekModel,
} from '@/lib/deepseek';
import { validateModelDiagnosis } from '@/lib/model-diagnosis';
import type { DiagnosisPacket } from '@/lib/model-diagnosis';
import type { AnalysisPacket } from '@/lib/ai-reliability';
import { sha256 } from '@/lib/ai-reliability';
import {
  claimDueAiJob,
  completeAiJob,
  failAiJob,
  predictionById,
  reconcileDiagnosisAiJobs,
  reconcilePostmatchAiJobs,
  reconcilePrematchAiJobs,
  recoverStaleAiJobs,
  saveAiRequestDiagnostic,
} from '@/lib/prediction-store';

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY))
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let limit = 1;
  let diagnostics = false;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      diagnostics?: boolean;
    };
    diagnostics = body.diagnostics === true;
    limit = Math.min(Math.max(Math.trunc(Number(body.limit ?? 1)), 1), 5);
  } catch {
    limit = 1;
  }
  const modelId = deepSeekModel(env);
  const reconciled = {
    prematch: await reconcilePrematchAiJobs(env.DB, modelId),
    postmatch: await reconcilePostmatchAiJobs(env.DB, modelId),
    diagnosis: await reconcileDiagnosisAiJobs(env.DB, modelId),
  };
  const recovered = await recoverStaleAiJobs(env.DB);
  const processed: Array<{
    predictionId: string;
    stage: string;
    status: string;
    category?: string;
    validationError?: string;
    rejectedOutput?: unknown;
  }> = [];
  for (let index = 0; index < limit; index += 1) {
    const job = await claimDueAiJob(env.DB);
    if (!job) break;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      if (!env.DEEPSEEK_API_KEY)
        throw Object.assign(new Error('deepseek_key_missing'), {
          code: 'deepseek_key_missing',
          stage: 'configuration',
          retryable: false,
          payloadBytes: 0,
        });
      const prediction = await predictionById(env.DB, job.predictionId);
      if (!prediction)
        throw Object.assign(new Error('prediction_missing'), {
          code: 'prediction_missing',
          stage: 'database',
          retryable: false,
          payloadBytes: 0,
        });
      if (
        job.stage === 'prematch' &&
        (prediction.status !== 'locked' ||
          Date.parse(prediction.scheduledAt) <= Date.now())
      ) {
        throw Object.assign(new Error('prematch_window_closed'), {
          code: 'prematch_window_closed',
          stage: 'temporal_gate',
          retryable: false,
          payloadBytes: 0,
        });
      }
      if (
        job.stage === 'postmatch' &&
        (!prediction.resultEvidence || !prediction.scorecard)
      ) {
        throw Object.assign(new Error('resolved_prediction_evidence_missing'), {
          code: 'resolved_prediction_evidence_missing',
          stage: 'database',
          retryable: false,
          payloadBytes: 0,
        });
      }
      if (
        job.stage === 'diagnosis' &&
        (prediction.status !== 'resolved' ||
          (await sha256(prediction.resultEvidence)) !== job.rawEvidenceHash)
      ) {
        throw Object.assign(new Error('diagnosis_result_revision_conflict'), {
          code: 'diagnosis_result_revision_conflict',
          stage: 'evidence_gate',
          retryable: false,
          payloadBytes: 0,
        });
      }
      const analyzed =
        job.stage === 'prematch'
          ? await analyzePrematch(env.DEEPSEEK_API_KEY, modelId, prediction, {
              packet: job.analysisPacket,
              promptVersion: job.promptVersion,
              onDiagnostic: (record) =>
                saveAiRequestDiagnostic(env.DB, job, record),
            })
          : job.stage === 'diagnosis'
            ? await analyzePostmatchModelDiagnosis(
                env.DEEPSEEK_API_KEY,
                modelId,
                job.analysisPacket as DiagnosisPacket,
              )
            : await analyzePostmatchR2(
                env.DEEPSEEK_API_KEY,
                modelId,
                prediction,
                job.analysisPacket as AnalysisPacket,
                {
                  ...job,
                  onDiagnostic: (record) =>
                    saveAiRequestDiagnostic(env.DB, job, record),
                },
              );
      try {
        if (job.stage === 'prematch')
          validatePrematchAnalysis(
            analyzed.output,
            job.promptVersion === 'vct-prematch-deepseek-v4-evidence1'
              ? (job.analysisPacket as unknown as Parameters<
                  typeof validatePrematchAnalysis
                >[1])
              : undefined,
          );
        else if (job.stage === 'diagnosis')
          validateModelDiagnosis(
            analyzed.output,
            job.analysisPacket as DiagnosisPacket,
          );
        else
          validateR2Analysis(
            analyzed.output,
            job.analysisPacket as AnalysisPacket,
          );
      } catch (error) {
        // Authenticated diagnostic response only; never publish invalid prose
        // or pretend that a schema failure was a successful reader article.
        if (diagnostics)
          processed.push({
            predictionId: job.predictionId,
            stage: job.stage,
            status: 'VALIDATION_REJECTED',
            validationError:
              error instanceof Error
                ? error.message
                : 'schema_validation_failed',
            rejectedOutput: analyzed.output,
          });
        throw Object.assign(
          error instanceof Error
            ? error
            : new Error('schema_validation_failed'),
          {
            code:
              error instanceof Error
                ? error.message
                : 'schema_validation_failed',
            stage: 'schema',
            retryable: false,
            httpStatus: analyzed.meta.httpStatus,
            inputTokens: analyzed.meta.inputTokens,
            outputTokens: analyzed.meta.outputTokens,
            payloadBytes: analyzed.meta.payloadBytes,
          },
        );
      }
      await completeAiJob(
        env.DB,
        job,
        analyzed.output as Record<string, unknown>,
        analyzed.meta,
      );
      processed.push({
        predictionId: job.predictionId,
        stage: job.stage,
        status: 'SUCCESS',
      });
    } catch (error) {
      if (
        diagnostics &&
        error &&
        typeof error === 'object' &&
        'rejectedOutput' in error
      )
        processed.push({
          predictionId: job.predictionId,
          stage: job.stage,
          status: 'VALIDATION_REJECTED',
          validationError:
            error instanceof Error ? error.message : 'schema_validation_failed',
          rejectedOutput: error.rejectedOutput,
        });
      const failure = classifyAiFailure(error);
      const completedAt = new Date().toISOString();
      try {
        const status = await failAiJob(env.DB, job, failure, {
          requestStartedAt: startedAt,
          requestCompletedAt: completedAt,
          latencyMs: Math.max(0, Date.now() - started),
          payloadBytes: failure.payloadBytes ?? 0,
        });
        processed.push({
          predictionId: job.predictionId,
          stage: job.stage,
          status,
          category: failure.category,
        });
      } catch {
        processed.push({
          predictionId: job.predictionId,
          stage: job.stage,
          status: 'RUNNING_DB_WRITE_FAILED',
          category: 'DB_WRITE_DUPLICATE',
        });
      }
    }
  }
  return NextResponse.json({
    accepted: true,
    reconciled,
    recovered,
    processed,
  });
}
