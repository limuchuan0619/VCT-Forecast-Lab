import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  buildDiagnosisPacket,
  validateModelDiagnosis,
} from '../lib/model-diagnosis.ts';
import {
  classifyAiFailure,
  validateR2Analysis,
} from '../lib/ai-reliability.ts';
import { verifiedTeamReviews } from '../lib/match-review.ts';
import type {
  ChallengerPrediction,
  PostmatchModelDiagnosis,
  PredictionSnapshot,
} from '../lib/vct-types.ts';

// Production SQL is exercised against an isolated in-memory SQLite D1 adapter.
// No live API, source, credentials, dataset or 100-match gate is used.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return {
        url: 'data:text/javascript,export const env = {};',
        shortCircuit: true,
      };
    if (
      specifier.startsWith('.') &&
      context.parentURL?.startsWith('file:') &&
      !/\.[a-z]+$/i.test(specifier)
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate))
        return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const store = await import('../lib/prediction-store.ts');

test('comparison view joins existing C1 and prematch metadata read-only without writes', async () => {
  const { database, db, prediction } = await fixture();
  database.raw
    .prepare(`INSERT INTO ai_analyses(id,prediction_id,stage,provider,model_id,prompt_version,status,output_json,direct_promotion_allowed,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(
      'pre1',
      prediction.id,
      'prematch',
      'deepseek',
      'isolated-model',
      'isolated-prompt',
      'complete',
      JSON.stringify({
        stage: 'prematch',
        ai_probability_team_a: 0.55,
        direct_promotion_allowed: false,
      }),
      '0',
      '2026-09-01T01:00:00Z',
    );
  const { env } = await import('cloudflare:workers');
  const mutable = env as unknown as { DB?: D1Database };
  const previous = mutable.DB;
  mutable.DB = db;
  const before = database.raw
    .prepare('SELECT total_changes() AS count')
    .get()!.count;
  try {
    const rows = await store.listModelComparisonRecords();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prematchAiCreatedAt, '2026-09-01T01:00:00Z');
    assert.equal(rows[0].prematchAiModelId, 'isolated-model');
    assert.equal(rows[0].prematchAnalysis!.ai_probability_team_a, 0.55);
    assert.equal(rows[0].challenger!.challengerProbability, 0.7);
    const detail = await store.predictionRecordById(prediction.id);
    assert.equal(detail!.challenger!.featureSnapshotHash, 'a'.repeat(64));
    assert.equal(detail!.prematchAiCreatedAt, rows[0].prematchAiCreatedAt);
    assert.equal(
      database.raw.prepare('SELECT total_changes() AS count').get()!.count,
      before,
    );
  } finally {
    mutable.DB = previous;
    database.raw.close();
  }
});

test('date query reaches beyond recent 100 and history pagination is read-only, complete and deterministic', async () => {
  const { database, db, prediction } = await fixture();
  const { env } = await import('cloudflare:workers');
  const mutable = env as unknown as { DB?: D1Database },
    previous = mutable.DB;
  mutable.DB = db;
  try {
    const template = database.raw
      .prepare('SELECT * FROM predictions WHERE id=?')
      .get(prediction.id)!;
    const columns = Object.keys(template),
      insert = database.raw.prepare(
        `INSERT INTO predictions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      );
    for (let i = 0; i < 120; i++) {
      const row: typeof template = {
        ...template,
        id: `new-${String(i).padStart(3, '0')}`,
        scheduled_at: '2026-10-04T05:00:00Z',
      };
      insert.run(...columns.map((c) => row[c]));
    }
    const before = database.raw.prepare('SELECT total_changes() n').get()!.n;
    assert.equal((await store.listPredictionRecords()).length, 100);
    const old = await store.predictionsForDay('2026-09-02', 'CN');
    assert.equal(old.length, 1);
    assert.equal(old[0].id, prediction.id);
    assert.equal(
      (await store.predictionsForDay('2026-10-04', 'CN')).length,
      120,
    );
    const ids = new Set<string>();
    for (let page = 1; page <= 7; page++) {
      const result = await store.predictionHistoryPage(page);
      assert.equal(result.total, 121);
      assert.equal(result.pages, 7);
      for (const row of result.records) {
        assert.equal(ids.has(row.id), false);
        ids.add(row.id);
      }
    }
    assert.equal(ids.size, 121);
    assert.equal((await store.predictionHistoryPage(999)).page, 7);
    assert.equal(
      database.raw.prepare('SELECT total_changes() n').get()!.n,
      before,
    );
  } finally {
    mutable.DB = previous;
    database.raw.close();
  }
});

test('detail exposes only the persisted packet linked to the displayed postmatch output', async () => {
  const { database, db, prediction } = await fixture();
  await store.ensurePostmatchAiJob(db, prediction, 'isolated-provider');
  const job = (await store.claimDueAiJob(db))!;
  const output = {
    stage: 'postmatch',
    hypotheses: [
      {
        hypothesis: 'Further evidence is needed',
        evidence_ids: ['fact:map:1'],
        confidence: 0.3,
      },
    ],
    direct_promotion_allowed: false,
  };
  await store.completeAiJob(db, job, output, {
    requestStartedAt: '2026-09-03T01:00:00Z',
    requestCompletedAt: '2026-09-03T01:00:01Z',
    latencyMs: 1,
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 10,
    payloadBytes: 100,
  });
  const { env } = await import('cloudflare:workers');
  const mutable = env as unknown as { DB?: D1Database },
    previous = mutable.DB;
  mutable.DB = db;
  try {
    const before = database.raw.prepare('SELECT total_changes() n').get()!.n;
    assert.equal(
      (await store.predictionRecordById(prediction.id))!.postmatchEvidence!
        .prediction.predictionId,
      prediction.id,
    );
    assert.equal(
      database.raw.prepare('SELECT total_changes() n').get()!.n,
      before,
    );
    database.raw
      .prepare('UPDATE predictions SET result_evidence_json=? WHERE id=?')
      .run(
        JSON.stringify({
          ...prediction.resultEvidence,
          source: {
            ...prediction.resultEvidence!.source,
            capturedAt: '2026-09-04T01:00:00Z',
          },
        }),
        prediction.id,
      );
    assert.equal(
      (await store.predictionRecordById(prediction.id))!.postmatchEvidence,
      null,
    );
  } finally {
    mutable.DB = previous;
    database.raw.close();
  }
});

test('postmatch prompt upgrade preserves prior jobs and completed legacy analysis; explicit revision is append-only', async () => {
  const { database, db, prediction } = await fixture();
  try {
    const legacy = await store.ensurePostmatchAiJob(
      db,
      prediction,
      'isolated-provider',
      {
        promptVersion: 'vct-postmatch-deepseek-v4-r2.1',
        schemaVersion: 'v1.4c-r2-postmatch-analysis-v1',
      },
    );
    assert.ok('analysisPacket' in legacy.job);
    if ('analysisPacket' in legacy.job)
      assert.equal(
        (legacy.job.analysisPacket as { reviewFocus?: string }).reviewFocus,
        undefined,
      );
    const original = database.raw
      .prepare('SELECT * FROM ai_analysis_jobs')
      .get();
    const ensured = await store.ensurePostmatchAiJob(
      db,
      prediction,
      'isolated-provider',
    );
    assert.equal(ensured.created, false);
    assert.deepEqual(
      database.raw.prepare('SELECT * FROM ai_analysis_jobs').get(),
      original,
    );
    const reconciliation = await store.reconcilePostmatchAiJobs(
      db,
      'isolated-provider',
    );
    assert.equal(reconciliation.created, 0);
    assert.equal(reconciliation.orphan, 0);
    const revised = await store.ensurePostmatchAiJob(
      db,
      prediction,
      'isolated-provider',
      { promptVersion: 'vct-postmatch-deepseek-v5-review1-result-revision-2' },
    );
    assert.equal(revised.created, true);
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analysis_jobs').get()!.n,
      2,
    );
    assert.deepEqual(
      database.raw
        .prepare('SELECT * FROM ai_analysis_jobs WHERE id=?')
        .get(original!.id),
      original,
    );
  } finally {
    database.raw.close();
  }
  const second = await fixture();
  try {
    await store.saveAiAnalysis(second.db, {
      predictionId: second.prediction.id,
      stage: 'postmatch',
      modelId: 'isolated-provider',
      promptVersion: 'legacy',
      status: 'complete',
      output: {
        stage: 'postmatch',
        summary: 'preserve original',
        direct_promotion_allowed: false,
      },
    });
    const preserved = await store.ensurePostmatchAiJob(
      second.db,
      second.prediction,
      'isolated-provider',
    );
    assert.equal(preserved.created, false);
    assert.equal(preserved.job.status, 'SUCCESS');
    assert.equal(
      (await store.reconcilePostmatchAiJobs(second.db, 'isolated-provider'))
        .orphan,
      0,
    );
    assert.equal(
      second.database.raw
        .prepare('SELECT COUNT(*) n FROM ai_analysis_jobs')
        .get()!.n,
      0,
    );
  } finally {
    second.database.raw.close();
  }
});

test('single-record editorial refresh appends once and never upgrades automatic jobs', async () => {
  const { database, db, prediction } = await fixture();
  try {
    const initial = await store.ensurePostmatchAiJob(
      db,
      prediction,
      'isolated-provider',
      {
        promptVersion: 'vct-postmatch-deepseek-v14-reader2',
        schemaVersion: 'v1.4c-reader2-postmatch-analysis-v11',
      },
    );
    const old = database.raw.prepare('SELECT * FROM ai_analysis_jobs').get();
    assert.equal(old!.prompt_version, 'vct-postmatch-deepseek-v14-reader2');
    const before = database.raw.prepare('SELECT * FROM predictions').all();
    const trial = await store.refreshReaderReview(
      db,
      prediction,
      'isolated-provider',
    );
    assert.equal(trial.created, true);
    assert.ok(
      'analysisPacket' in trial.job &&
        (trial.job.analysisPacket as any).readerInsights,
    );
    const again = await store.refreshReaderReview(
      db,
      prediction,
      'isolated-provider',
    );
    assert.equal(again.created, false);
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analysis_jobs').get()!.n,
      2,
    );
    assert.deepEqual(
      database.raw
        .prepare('SELECT * FROM ai_analysis_jobs WHERE id=?')
        .get((initial.job as any).id),
      old,
    );
    assert.deepEqual(
      database.raw.prepare('SELECT * FROM predictions').all(),
      before,
    );
    assert.equal(
      (await store.ensurePostmatchAiJob(db, prediction, 'isolated-provider'))
        .created,
      false,
    );
  } finally {
    database.raw.close();
  }
});

test('private request diagnostics never become completed articles or change a frozen prediction', async () => {
  const { database, db, prediction } = await fixture();
  try {
    const registered = await store.ensurePostmatchAiJob(
      db,
      prediction,
      'isolated-provider',
    );
    const before = database.raw.prepare('SELECT * FROM predictions').all();
    await store.saveAiRequestDiagnostic(db, registered.job as any, {
      phase: 'article',
      rawResponse: '{"output_text":"rejected"}',
      requestHash: 'a'.repeat(64),
    });
    const diagnostic = database.raw
      .prepare("SELECT * FROM ai_analyses WHERE status='diagnostic'")
      .get();
    assert.ok(diagnostic);
    assert.equal(
      await store.latestAiAnalysisStatus(db, prediction.id, 'postmatch'),
      null,
    );
    assert.equal(
      database.raw
        .prepare("SELECT COUNT(*) n FROM ai_analyses WHERE status='complete'")
        .get()!.n,
      0,
    );
    assert.deepEqual(
      database.raw.prepare('SELECT * FROM predictions').all(),
      before,
    );
    assert.equal(
      (await store.latestAiJob(db, prediction.id, 'postmatch'))!.status,
      'PENDING',
    );
  } finally {
    database.raw.close();
  }
});

test('public overview excludes diagnostic and failed payloads, preserving the last complete article', async () => {
  const { database, db, prediction } = await fixture();
  const { env } = await import('cloudflare:workers');
  const mutable = env as unknown as { DB?: D1Database };
  const previous = mutable.DB;
  mutable.DB = db;
  const insert = database.raw
    .prepare(`INSERT INTO ai_analyses(id,prediction_id,stage,provider,model_id,prompt_version,status,output_json,direct_promotion_allowed,created_at)
    VALUES(?,?,'prematch','deepseek','isolated-model','isolated-prompt',?,?,0,?)`);
  try {
    insert.run(
      'private-diagnostic',
      prediction.id,
      'diagnostic',
      JSON.stringify({
        schemaVersion: 'ai-private-attempt-v1',
        rawResponse: 'private-response-marker',
      }),
      '2026-10-22T00:00:00Z',
    );
    assert.equal((await store.loadPublicOverview()).ai.analysis, null);
    assert.equal(
      (await store.predictionRecordById(prediction.id))!.prematchAiStatus,
      null,
    );
    insert.run(
      'failed-output',
      prediction.id,
      'failed',
      JSON.stringify({ rawResponse: 'failed-response-marker' }),
      '2026-10-20T00:00:00Z',
    );
    assert.equal((await store.loadPublicOverview()).ai.analysis, null);
    const accepted = {
      stage: 'prematch',
      summary: 'Accepted isolated article only.',
    };
    insert.run(
      'complete-output',
      prediction.id,
      'complete',
      JSON.stringify(accepted),
      '2026-10-21T00:00:00Z',
    );
    const before = database.raw.prepare('SELECT total_changes() AS n').get()!.n;
    const overview = await store.loadPublicOverview();
    assert.deepEqual(overview.ai.analysis, accepted);
    assert.equal(overview.ai.status, 'available');
    assert.doesNotMatch(
      JSON.stringify(overview),
      /private-response-marker|failed-response-marker|ai-private-attempt-v1/,
    );
    assert.equal(
      (await store.predictionRecordById(prediction.id))!.prematchAiStatus,
      'complete',
    );
    assert.equal(
      database.raw.prepare('SELECT total_changes() AS n').get()!.n,
      before,
    );
    assert.equal(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM ai_analyses WHERE status='diagnostic'",
        )
        .get()!.n,
      1,
    );
  } finally {
    mutable.DB = previous;
    database.raw.close();
  }
});

test('prematch prompt upgrade preserves an existing queued job and its original packet', async () => {
  const { database, db, prediction } = await fixture();
  try {
    const future = {
      ...prediction,
      status: 'locked' as const,
      scheduledAt: '2099-01-01T00:00:00Z',
    };
    const first = await store.ensurePrematchAiJob(
      db,
      future,
      'isolated-provider',
    );
    assert.equal(first.created, true);
    const before = database.raw
      .prepare(
        "SELECT analysis_packet_json FROM ai_analysis_jobs WHERE stage='prematch'",
      )
      .get();
    database.raw
      .prepare(
        "UPDATE ai_analysis_jobs SET prompt_version='vct-prematch-deepseek-v2.2' WHERE stage='prematch'",
      )
      .run();
    const next = await store.ensurePrematchAiJob(
      db,
      future,
      'isolated-provider',
    );
    assert.equal(next.created, false);
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analysis_jobs').get()!.n,
      1,
    );
    assert.deepEqual(
      database.raw
        .prepare(
          "SELECT analysis_packet_json FROM ai_analysis_jobs WHERE stage='prematch'",
        )
        .get(),
      before,
    );
  } finally {
    database.raw.close();
  }
});

test('new settled fixture produces new bounded two-team packet once, before independent provider work', async () => {
  const { database, db, prediction } = await fixture();
  try {
    const before = database.raw
      .prepare('SELECT team_a_probability FROM predictions')
      .get();
    const first = await store.ensurePostmatchAiJob(
      db,
      prediction,
      'isolated-provider',
    );
    assert.equal(first.created, true);
    assert.ok('analysisPacket' in first.job);
    if ('analysisPacket' in first.job)
      assert.equal(
        (first.job.analysisPacket as { reviewFocus: string }).reviewFocus,
        'team_outcomes_v1',
      );
    assert.equal(
      (await store.ensurePostmatchAiJob(db, prediction, 'isolated-provider'))
        .created,
      false,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analysis_jobs').get()!.n,
      1,
    );
    assert.deepEqual(
      database.raw.prepare('SELECT team_a_probability FROM predictions').get(),
      before,
    );
    const job = (await store.claimDueAiJob(db))!;
    const output = {
      stage: 'postmatch',
      one_line_summary: 'A拿下两张地图，B未能扳回地图。',
      reader_review: {
        summary: 'A获胜，选手资料不足。',
        reasons: [],
        maps: prediction.resultEvidence!.maps.map((map) => ({
          order: map.order,
          map: map.map,
          fact: `${map.winner} 拿下本图。`,
          interpretation: '选手资料不足，不能推测具体战术。',
          evidence_ids: [`fact:map:${map.order}`],
        })),
        matchups: [],
      },
      what_happened: [
        { claim: 'A 2:0获胜。', evidence_ids: ['fact:result_evidence'] },
      ],
      three_signals: [
        {
          signal: '赛前更看好A。',
          relation: 'supported_result',
          evidence_ids: ['prediction:locked_snapshot'],
        },
      ],
      team_reviews: [
        {
          team: 'A',
          outcome: 'won',
          strengths: [
            { claim: '莲华古城13:8取胜。', evidence_ids: ['fact:map:1'] },
          ],
          weaknesses: [],
          possible_explanation: null,
        },
        {
          team: 'B',
          outcome: 'lost',
          strengths: [],
          weaknesses: [
            { claim: '隐世修所8:13失利。', evidence_ids: ['fact:map:2'] },
          ],
          possible_explanation: null,
        },
      ],
      map_reviews: [],
      player_outliers: [],
      hypotheses: [],
      missing_evidence: ['round_timeline'],
      research_queue: null,
      direct_probability_change_allowed: false,
      direct_training_allowed: false,
      direct_promotion_allowed: false,
    };
    validateR2Analysis(
      output,
      job.analysisPacket as import('../lib/ai-reliability.ts').AnalysisPacket,
    );
    await store.completeAiJob(db, job, output, {
      requestStartedAt: '2026-09-03T01:00:00Z',
      requestCompletedAt: '2026-09-03T01:00:01Z',
      latencyMs: 1,
      httpStatus: 200,
      inputTokens: 1,
      outputTokens: 1,
      payloadBytes: 100,
    });
    const { env } = await import('cloudflare:workers');
    const mutable = env as unknown as { DB?: D1Database },
      previous = mutable.DB;
    mutable.DB = db;
    try {
      const detail = (await store.predictionRecordById(prediction.id))!;
      assert.equal(verifiedTeamReviews(detail).length, 2);
      assert.equal(detail.teamAProbability, prediction.teamAProbability);
    } finally {
      mutable.DB = previous;
    }
    assert.equal(
      (await store.ensurePostmatchAiJob(db, prediction, 'isolated-provider'))
        .created,
      false,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analyses').get()!.n,
      1,
    );
  } finally {
    database.raw.close();
  }
});

test('explicit reader refresh appends one versioned job, preserves prior analysis and never rewrites prediction', async () => {
  const { database, db, prediction } = await fixture();
  try {
    const old = await store.ensurePostmatchAiJob(
      db,
      prediction,
      'isolated-provider',
      {
        promptVersion: 'vct-postmatch-deepseek-v5-review1',
        schemaVersion: 'v1.4c-review1-postmatch-analysis-v2',
      },
    );
    const before = database.raw.prepare('SELECT * FROM predictions').all();
    const oldJob = database.raw.prepare('SELECT * FROM ai_analysis_jobs').all();
    const revision = await store.refreshReaderReview(
      db,
      prediction,
      'isolated-provider',
    );
    assert.equal(old.created, true);
    assert.equal(revision.created, true);
    assert.equal(
      (await store.refreshReaderReview(db, prediction, 'isolated-provider'))
        .created,
      false,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analysis_jobs').get()!.n,
      2,
    );
    assert.deepEqual(
      database.raw.prepare('SELECT * FROM predictions').all(),
      before,
    );
    assert.deepEqual(
      database.raw
        .prepare('SELECT * FROM ai_analysis_jobs WHERE id=?')
        .all(oldJob[0].id),
      oldJob,
    );
  } finally {
    database.raw.close();
  }
});

test('explicit transport recovery resumes one reader job without resetting attempts or frozen input', async () => {
  const { database, db, prediction } = await fixture();
  try {
    await store.refreshReaderReview(db, prediction, 'isolated-provider');
    database.raw
      .prepare(
        "UPDATE ai_analysis_jobs SET status='RETRY_SCHEDULED',attempt_count=2,error_code='TIMEOUT_CONNECTION',next_retry_at='2099-01-01T00:00:00Z'",
      )
      .run();
    const before = database.raw
      .prepare('SELECT * FROM ai_analysis_jobs')
      .get()!;
    const resumed = await store.refreshReaderReview(
      db,
      prediction,
      'isolated-provider',
    );
    const after = database.raw.prepare('SELECT * FROM ai_analysis_jobs').get()!;
    assert.equal(resumed.created, false);
    assert.equal(after.attempt_count, 2);
    for (const key of [
      'id',
      'analysis_packet_json',
      'analysis_packet_hash',
      'raw_evidence_hash',
      'logical_key',
      'prompt_version',
      'schema_version',
    ])
      assert.equal(after[key], before[key]);
    assert.ok(Date.parse(String(after.next_retry_at)) <= Date.now());
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analysis_jobs').get()!.n,
      1,
    );
  } finally {
    database.raw.close();
  }
});

class TestD1 {
  raw = new DatabaseSync(':memory:');
  constructor() {
    const directory = new URL('../drizzle/', import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith('.sql') && !name.includes('seed'))
      .sort())
      this.raw.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  prepare(sql: string) {
    const statement = this.raw.prepare(sql);
    let values: Array<string | number | null> = [];
    const prepared = {
      bind: (...input: Array<string | number | null>) => {
        values = input;
        return prepared;
      },
      first: async () => statement.get(...values) ?? null,
      all: async () => ({ results: statement.all(...values) }),
      run: async () => ({
        meta: { changes: Number(statement.run(...values).changes) },
      }),
    };
    return prepared;
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    this.raw.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec('COMMIT');
      return results;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
  asD1() {
    return this as unknown as D1Database;
  }
}

async function fixture() {
  const database = new TestD1();
  const db = database.asD1();
  const evidence: PredictionSnapshot['resultEvidence'] = {
    schemaVersion: 'v1.4c-r1-result-evidence-v1',
    source: { sourceId: 'vlr', capturedAt: '2026-09-02T04:00:00Z' },
    series: {
      actualWinner: 'A',
      actualScore: '2-0',
      scheduledAt: '2026-09-02T00:00:00Z',
      seriesFormat: 'bo3',
    },
    maps: [1, 2].map((order) => ({
      order,
      map: order === 1 ? '莲华古城' : '隐世修所',
      teamAScore: 13,
      teamBScore: 8,
      winner: 'A',
      missingFields: ['attack_defense'],
    })),
    playerStats: null,
    missing: {
      maps: false,
      playerStats: true,
      attackDefense: true,
      veto: true,
    },
  };
  const locked: PredictionSnapshot = {
    id: 'isolated-p',
    source: 'system_auto',
    modelVersion: 'v1.0.0',
    lockedAt: '2026-09-01T00:00:00Z',
    scheduledAt: '2026-09-02T00:00:00Z',
    event: 'ISOLATED TEST',
    region: 'CN',
    seriesFormat: 'bo3',
    teamA: 'A',
    teamB: 'B',
    teamAProbability: 0.6,
    predictedScore: '2-0',
    status: 'locked',
    dataCutoffAt: '2026-09-01T00:00:00Z',
    factors: [],
    maps: [],
    scoreDistribution: { '2-0': 0.4, '2-1': 0.2, '0-2': 0.2, '1-2': 0.2 },
    evidence: {
      sourceLabel: 'ISOLATED',
      patchProvenance: 'event_cohort',
      qualityGate: 'ready',
    },
  };
  await store.upsertPrediction(db, locked);
  const shadow: ChallengerPrediction = {
    id: 'isolated-c1',
    fixtureId: 'isolated-f',
    championPredictionId: locked.id,
    featureSnapshotId: 'isolated-s',
    featureSnapshotHash: 'a'.repeat(64),
    features: { team_rating_diff: 10 },
    featureStatus: { team_rating_diff: 'observed' },
    evidence: {},
    frozenAt: locked.lockedAt,
    scheduledAt: locked.scheduledAt,
    championModelVersion: 'v1.0.0',
    championProbability: 0.6,
    challengerModelId: 'logistic_c1_v1.4b_20260903',
    datasetVersion: 'v1.4b-c1-20260903',
    artifactHash: 'b'.repeat(64),
    challengerProbability: 0.7,
    probabilityDelta: 0.1,
    dataQualityState: 'ready',
    recordKind: 'real_prospective',
    eligible: true,
    status: 'locked',
  };
  await store.upsertChallengerPrediction(db, shadow);
  const prediction = await store.resolvePrediction(
    db,
    locked.id,
    'A',
    '2-0',
    evidence.source.capturedAt,
    evidence,
  );
  const challenger = (await store.resolveChallenger(
    db,
    prediction,
    'A',
    evidence.source.capturedAt,
  ))!;
  return { database, db, prediction, challenger };
}

function diagnosis(
  packet: ReturnType<typeof buildDiagnosisPacket>,
): PostmatchModelDiagnosis {
  return {
    stage: 'postmatch_model_diagnosis',
    prediction_summary: packet.input.expected_summary,
    model_agreement: packet.input
      .expected_agreement as PostmatchModelDiagnosis['model_agreement'],
    facts: [{ claim: 'A won', evidence_ids: ['fact:result'] }],
    model_signals: [
      { claim: 'Both favored A', evidence_ids: ['model:champion', 'model:c1'] },
    ],
    hypotheses: [
      {
        hypothesis: 'Further data might explain variation',
        tag: 'missing_context',
        evidence_ids: ['system:scorecard'],
        confidence: 0.3,
      },
    ],
    diagnostic_tags: ['missing_context'],
    research_hypothesis: null,
    confidence: 0.3,
    direct_probability_change_allowed: false,
    direct_training_allowed: false,
    direct_promotion_allowed: false,
  };
}

test('real settlement SQL commits before queued diagnosis, with no provider call', async () => {
  const { database, db, prediction, challenger } = await fixture();
  try {
    const before = JSON.stringify(
      database.raw.prepare('SELECT * FROM predictions').get(),
    );
    assert.equal(
      (
        await store.ensureDiagnosisAiJob(
          db,
          prediction,
          challenger,
          'test-model',
        )
      ).created,
      true,
    );
    assert.equal(
      (
        await store.ensureDiagnosisAiJob(
          db,
          prediction,
          challenger,
          'test-model',
        )
      ).created,
      false,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analysis_jobs').get()!.n,
      1,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM challenger_diagnoses').get()!
        .n,
      0,
    );
    assert.equal(
      JSON.stringify(database.raw.prepare('SELECT * FROM predictions').get()),
      before,
    );
  } finally {
    database.raw.close();
  }
});

test('diagnosis timeout retries and completes atomically without changing frozen probability', async () => {
  const { database, db, prediction, challenger } = await fixture();
  try {
    await store.ensureDiagnosisAiJob(db, prediction, challenger, 'test-model');
    const job = (await store.claimDueAiJob(db))!;
    assert.equal(job.stage, 'diagnosis');
    const timing = {
      requestStartedAt: new Date().toISOString(),
      requestCompletedAt: new Date().toISOString(),
      latencyMs: 1,
      payloadBytes: 100,
    };
    assert.equal(
      await store.failAiJob(
        db,
        job,
        classifyAiFailure(new Error('deepseek_timeout')),
        timing,
      ),
      'RETRY_SCHEDULED',
    );
    assert.equal(
      database.raw.prepare('SELECT status FROM predictions').get()!.status,
      'resolved',
    );
    const retry = (await store.claimDueAiJob(
      db,
      new Date(Date.now() + 360_000),
    ))!;
    assert.equal(retry.attemptCount, 2);
    const packet = buildDiagnosisPacket(prediction, challenger);
    const output = diagnosis(packet);
    validateModelDiagnosis(output, packet);
    await store.completeAiJob(
      db,
      retry,
      output as unknown as Record<string, unknown>,
      { ...timing, httpStatus: 200, inputTokens: 10, outputTokens: 10 },
    );
    assert.equal(
      database.raw.prepare('SELECT status FROM ai_analysis_jobs').get()!.status,
      'SUCCESS',
    );
    assert.equal(
      database.raw
        .prepare(
          "SELECT COUNT(*) n FROM challenger_diagnoses WHERE status='complete'",
        )
        .get()!.n,
      1,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_provider_attempts').get()!
        .n,
      2,
    );
    assert.equal(
      database.raw.prepare('SELECT team_a_probability FROM predictions').get()!
        .team_a_probability,
      0.6,
    );
    assert.equal(
      database.raw
        .prepare('SELECT challenger_probability FROM challenger_predictions')
        .get()!.challenger_probability,
      0.7,
    );
    assert.equal(
      await store.claimDueAiJob(db, new Date(Date.now() + 86400_000)),
      null,
    );
    assert.equal(
      (await store.reconcileDiagnosisAiJobs(db, 'test-model')).created,
      0,
    );
    assert.equal(
      (
        await store.ensureDiagnosisAiJob(
          db,
          prediction,
          challenger,
          'test-model',
        )
      ).status,
      'SUCCESS',
    );
  } finally {
    database.raw.close();
  }
});

test('stale diagnosis leases recover independently and historical/blocked rows do not reconcile', async () => {
  const { database, db, prediction, challenger } = await fixture();
  try {
    await store.ensureDiagnosisAiJob(db, prediction, challenger, 'test-model');
    await store.claimDueAiJob(db);
    database.raw.exec(
      "UPDATE ai_analysis_jobs SET request_started_at='2020-01-01T00:00:00Z'",
    );
    assert.equal(await store.recoverStaleAiJobs(db), 1);
    assert.equal((await store.claimDueAiJob(db))!.attemptCount, 2);
    database.raw.exec(
      "DELETE FROM ai_analysis_jobs; UPDATE challenger_predictions SET eligible=0,record_kind='isolated_test'",
    );
    assert.equal(
      (await store.reconcileDiagnosisAiJobs(db, 'test-model')).created,
      0,
    );
  } finally {
    database.raw.close();
  }
});

test('diagnosis validation rejects probability control, invented evidence and changed probabilities', async () => {
  const { database, prediction, challenger } = await fixture();
  try {
    const packet = buildDiagnosisPacket(prediction, challenger),
      valid = diagnosis(packet);
    assert.doesNotThrow(() => validateModelDiagnosis(valid, packet));
    assert.throws(() =>
      validateModelDiagnosis(
        { ...valid, direct_training_allowed: true },
        packet,
      ),
    );
    assert.throws(() =>
      validateModelDiagnosis(
        {
          ...valid,
          prediction_summary: {
            ...valid.prediction_summary,
            champion_probability_team_a: 0.99,
          },
        },
        packet,
      ),
    );
    assert.throws(() =>
      validateModelDiagnosis(
        {
          ...valid,
          facts: [{ claim: 'invented', evidence_ids: ['private:unknown'] }],
        },
        packet,
      ),
    );
    assert.ok(JSON.stringify(packet).length < 40_000);
  } finally {
    database.raw.close();
  }
});

test('D1 integrity independently detects incorrect Runner aggregates and invalid ledger records', async () => {
  const { database, db } = await fixture();
  try {
    const base = {
      modelId: 'logistic_c1_v1.4b_20260903',
      status: 'SHADOW' as const,
      phase: 'ACCUMULATING' as const,
      eligibleResolvedMatches: 1,
      gate: 100 as const,
      promotionStatus: 'EVALUATING' as const,
      promotionEnabled: false as const,
      historicalEvaluationIncluded: false as const,
      metricIntegrity: {
        status: 'TRUSTED',
        schema_version: 'v1.4c-r2.3-shadow-settlement-v1',
      },
      metrics: {
        champion: {
          brier: 0.16,
          log_loss: -Math.log(0.6),
          accuracy: 1,
          ece_10_bin: 0.4,
        },
        logistic_c1: {
          brier: 0.09,
          log_loss: -Math.log(0.7),
          accuracy: 1,
          ece_10_bin: 0.3,
        },
      },
    };
    assert.equal(
      (await store.loadEvaluationIntegrity(db, base)).status,
      'TRUSTED',
    );
    assert.equal(
      (
        await store.loadEvaluationIntegrity(db, {
          ...base,
          metrics: {
            ...base.metrics,
            champion: { ...base.metrics.champion, accuracy: 0 },
          },
        })
      ).status,
      'DEGRADED',
    );
    database.raw.exec('UPDATE challenger_predictions SET champion_brier=.36');
    assert.equal(
      (await store.loadEvaluationIntegrity(db, base)).status,
      'DEGRADED',
    );
  } finally {
    database.raw.close();
  }
});

test('result revision during provider work rejects old diagnosis without reversing settlement', async () => {
  const { database, db, prediction, challenger } = await fixture();
  try {
    await store.ensureDiagnosisAiJob(db, prediction, challenger, 'test-model');
    const job = (await store.claimDueAiJob(db))!;
    const packet = buildDiagnosisPacket(prediction, challenger);
    const revisedEvidence = {
      ...prediction.resultEvidence!,
      source: {
        ...prediction.resultEvidence!.source,
        capturedAt: '2026-09-02T05:00:00Z',
      },
    };
    database.raw
      .prepare('UPDATE predictions SET result_evidence_json=? WHERE id=?')
      .run(JSON.stringify(revisedEvidence), prediction.id);
    const timing = {
      requestStartedAt: new Date().toISOString(),
      requestCompletedAt: new Date().toISOString(),
      latencyMs: 1,
      httpStatus: 200,
      inputTokens: 10,
      outputTokens: 10,
      payloadBytes: 100,
    };
    await assert.rejects(
      store.completeAiJob(
        db,
        job,
        diagnosis(packet) as unknown as Record<string, unknown>,
        timing,
      ),
      /result_revision_conflict/,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM challenger_diagnoses').get()!
        .n,
      0,
    );
    assert.equal(
      database.raw.prepare('SELECT status FROM predictions').get()!.status,
      'resolved',
    );
    await store.failAiJob(
      db,
      job,
      classifyAiFailure(
        Object.assign(new Error('diagnosis_result_revision_conflict'), {
          stage: 'evidence_gate',
          retryable: false,
        }),
      ),
      timing,
    );
    assert.equal(
      (await store.reconcileDiagnosisAiJobs(db, 'test-model')).created,
      1,
    );
    assert.equal(
      database.raw.prepare('SELECT COUNT(*) n FROM ai_analysis_jobs').get()!.n,
      2,
    );
  } finally {
    database.raw.close();
  }
});

test('diagnosis retries are bounded and do not contaminate prematch/postmatch health', async () => {
  const { database, db, prediction, challenger } = await fixture();
  try {
    await store.ensureDiagnosisAiJob(db, prediction, challenger, 'test-model');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const now = new Date(Date.now() + attempt * 86400_000).toISOString();
      const job = (await store.claimDueAiJob(db, new Date(now)))!;
      assert.equal(job.attemptCount, attempt);
      const status = await store.failAiJob(
        db,
        job,
        classifyAiFailure(new Error('deepseek_timeout')),
        {
          requestStartedAt: now,
          requestCompletedAt: now,
          latencyMs: 1,
          payloadBytes: 100,
        },
      );
      assert.equal(status, attempt < 5 ? 'RETRY_SCHEDULED' : 'FINAL_FAILED');
    }
    assert.equal(
      await store.claimDueAiJob(db, new Date(Date.now() + 7 * 86400_000)),
      null,
    );
    const health = await store.loadAiReliability(db);
    assert.equal(health.diagnosis.attempted, 5);
    assert.equal(health.diagnosis.health, 'FAILED');
    assert.equal(health.prematch.attempted, 0);
    assert.equal(health.postmatch.attempted, 0);
    assert.equal(
      database.raw.prepare('SELECT status FROM predictions').get()!.status,
      'resolved',
    );
  } finally {
    database.raw.close();
  }
});
