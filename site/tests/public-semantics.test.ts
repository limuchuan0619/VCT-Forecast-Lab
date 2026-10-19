import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('public detail lookup is system-only', () => {
  const store = read('lib/prediction-store.ts');
  assert.match(store, /WHERE p\.id=\? AND p\.source LIKE 'system%'/);
});

test('home shows tomorrow matches and explicit unavailable states without demo replacements', () => {
  const home = read('app/page.tsx');
  assert.match(home, /tomorrowChinaDay/);
  assert.match(home, /predictionsForDay\(day, region\)/);
  assert.doesNotMatch(home, /listPredictionRecords\(100\)/);
  assert.match(home, /MatchListCard/);
  assert.match(home, /overview\.dataMode !== 'LIVE'/);
  assert.doesNotMatch(home, /V1\.3\.02/);
});

test('DeepSeek cannot own deterministic postmatch correctness', () => {
  const deepseek = read('lib/deepseek.ts');
  assert.doesNotMatch(deepseek, /probability_was_reasonable/);
  assert.match(deepseek, /deterministic_scorecard_owned_by_system/);
  assert.match(deepseek, /fact_model_signal_hypothesis_separation_required/);
});

test('review listing stays compact and detail separates facts from AI hypotheses', () => {
  const reviews = read('app/reviews/page.tsx');
  const detail = read('app/predictions/[id]/page.tsx');
  assert.match(reviews, /MatchListCard/);
  assert.match(detail, /reviewSummary\(record\)/);
  assert.match(detail, /回看赛前判断/);
  assert.doesNotMatch(
    detail,
    /JSON\.stringify|replayFeatureName|EvidenceReferences|view === 'audit'/,
  );
  assert.doesNotMatch(
    reviews,
    />\{review\.variance_vs_model_error\.verdict\}</,
  );
  assert.doesNotMatch(reviews, /概率仍属合理/);
});

test('postmatch settlement and explicit retry both use the unique job state machine', () => {
  const settlement = read('app/api/automation/results/route.ts');
  const retry = read('app/api/automation/ai/retry/route.ts');
  assert.match(settlement, /ensurePostmatchAiJob/);
  assert.match(retry, /ensurePostmatchAiJob/);
  assert.doesNotMatch(retry, /analyzePostmatch\(/);
});

test('prematch analysis uses its own queued job path and never blocks prediction ingest', () => {
  const ingest = read('app/api/automation/predictions/route.ts');
  const jobs = read('app/api/automation/ai/jobs/route.ts');
  const retry = read('app/api/automation/ai/retry/route.ts');
  assert.match(ingest, /ensurePrematchAiJob/);
  assert.doesNotMatch(ingest, /analyzePrematch/);
  assert.match(jobs, /reconcilePrematchAiJobs/);
  assert.match(jobs, /job\.stage === 'prematch'/);
  assert.match(retry, /ensurePrematchAiJob/);
  assert.doesNotMatch(retry, /analyzePrematch/);
});

test('public labels distinguish prematch analysis from postmatch review', () => {
  assert.match(read('app/predictions/page.tsx'), /赛前 AI/);
  assert.match(read('app/reviews/page.tsx'), /赛后 AI/);
});

test('AI jobs are unique, attempts are append-only, and success persistence is batched', () => {
  const schema = read('db/schema.ts');
  const store = read('lib/prediction-store.ts');
  assert.match(schema, /uniqueIndex\('uq_ai_analysis_jobs_logical_key'\)/);
  assert.match(schema, /uniqueIndex\('uq_ai_provider_attempt_job_no'\)/);
  assert.match(store, /await db\.batch\(statements\)/);
  assert.doesNotMatch(store, /UPDATE ai_analyses/);
});

test('stale running jobs recover after worker restart and legacy analyses stay immutable', () => {
  const store = read('lib/prediction-store.ts');
  assert.match(store, /RUNNING lease expired and was recovered/);
  assert.match(store, /status='RETRY_SCHEDULED'/);
  assert.doesNotMatch(store, /DELETE FROM ai_analyses/);
});

test('AI provider or database failure cannot roll back deterministic result settlement', () => {
  const settlement = read('app/api/automation/results/route.ts');
  assert.match(settlement, /const prediction = await resolvePrediction/);
  assert.match(settlement, /ensurePostmatchAiJob/);
  assert.doesNotMatch(settlement, /analyzePostmatchR2/);
});
