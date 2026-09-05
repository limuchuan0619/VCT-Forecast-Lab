import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { isAutomationAuthorized } from '@/lib/automation-auth';
import { saveAutomationState } from '@/lib/prediction-store';
import type { AutomationSchedule, PublicOverview } from '@/lib/vct-types';

type StateInput = {
  coverage?: PublicOverview['data'];
  model?: {
    version: string;
    role: string;
    status: string;
    parentVersion?: string | null;
    trainingCutoff?: string | null;
    minimumSampleGate: number;
    observedSamples: number;
    metrics: object;
    constraints: object;
  };
  run?: {
    id: string;
    runType: string;
    status: string;
    startedAt: string;
    completedAt?: string | null;
    counters: object;
    errorCode?: string | null;
  };
  schedule?: AutomationSchedule;
  learning?: PublicOverview['learning'];
  challenger?: {
    modelId: string; status: 'SHADOW'; phase: 'ACCUMULATING' | 'PRELIMINARY' | 'EVALUATING' | 'GATE_READY';
    eligibleResolvedMatches: number; gate: 100; promotionStatus: 'EVALUATING' | 'GATE_READY'; promotionEnabled: false;
    historicalEvaluationIncluded: false;
  };
};

export async function POST(request: Request) {
  if (!isAutomationAuthorized(request, env.AUTOMATION_INGEST_KEY)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json() as StateInput;
    if (!body.coverage || !body.model) throw new Error('missing_state_fields');
    const numericValues = [body.coverage.matches, body.coverage.teams, body.coverage.predictions, body.coverage.regions,
      body.model.minimumSampleGate, body.model.observedSamples];
    if (numericValues.some((value) => !Number.isInteger(value) || value < 0)) throw new Error('invalid_state_counts');
    if (!body.model.version || !body.model.role || !body.model.status) throw new Error('invalid_model_state');
    if (!Number.isFinite(Date.parse(body.coverage.cutoffAt))) throw new Error('invalid_coverage_cutoff');
    if (body.run) {
      if (!body.run.id || !body.run.runType || !body.run.status || !body.run.startedAt) throw new Error('invalid_run_state');
      if (!Number.isFinite(Date.parse(body.run.startedAt))) throw new Error('invalid_run_started_at');
      if (body.run.completedAt && !Number.isFinite(Date.parse(body.run.completedAt))) throw new Error('invalid_run_completed_at');
      if (!body.run.counters || typeof body.run.counters !== 'object' || Array.isArray(body.run.counters)) throw new Error('invalid_run_counters');
      if (body.run.errorCode && body.run.errorCode.length > 512) throw new Error('invalid_run_error_code');
    }
    if (body.schedule) {
      if (!Number.isInteger(body.schedule.intervalSeconds) || body.schedule.intervalSeconds < 900 || body.schedule.intervalSeconds > 86400) throw new Error('invalid_schedule_interval');
      if (!Number.isInteger(body.schedule.horizonHours) || body.schedule.horizonHours < 1 || body.schedule.horizonHours > 336) throw new Error('invalid_schedule_horizon');
      if (body.schedule.executionEnvironment !== 'cloud') throw new Error('invalid_schedule_environment');
    }
    if (body.learning) {
      const counts = [body.learning.snapshots, body.learning.fixtures, body.learning.ready, body.learning.blocked,
        body.learning.labeled, body.learning.pending, body.learning.trainingEligible, body.learning.trainingGate];
      if (body.learning.mode !== 'prospective_gold' || counts.some((value) => !Number.isInteger(value) || value < 0)) {
        throw new Error('invalid_learning_state');
      }
      if (body.learning.startedAt && !Number.isFinite(Date.parse(body.learning.startedAt))) throw new Error('invalid_learning_started_at');
    }
    if (body.challenger) {
      if (!body.challenger.modelId || body.challenger.status !== 'SHADOW' || body.challenger.gate !== 100
        || !Number.isInteger(body.challenger.eligibleResolvedMatches) || body.challenger.eligibleResolvedMatches < 0
        || body.challenger.promotionEnabled !== false || body.challenger.historicalEvaluationIncluded !== false) throw new Error('invalid_challenger_state');
    }
    await saveAutomationState(env.DB, { coverage: body.coverage, model: body.model, run: body.run, schedule: body.schedule, learning: body.learning, challenger: body.challenger });
    return NextResponse.json({ accepted: true, version: body.model.version, coverage: body.coverage, runId: body.run?.id ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid_request' }, { status: 400 });
  }
}
