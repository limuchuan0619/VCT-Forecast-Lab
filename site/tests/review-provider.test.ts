import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
  POSTMATCH_JOB_PROMPT_VERSION,
  POSTMATCH_JOB_SCHEMA_VERSION,
  validateR2Analysis,
} from '../lib/ai-reliability.ts';
import { reviewFixture } from './fixtures/match-review.ts';
import {
  EDITORIAL_REVIEW_PROMPT,
  EDITORIAL_REVIEW_SCHEMA,
} from '../lib/review-editorial.ts';

registerHooks({
  resolve(specifier, context, next) {
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
const { analyzePostmatchR2, analyzePrematch } =
  await import('../lib/deepseek.ts');
const LEGACY_PROMPT = 'vct-postmatch-deepseek-v14-reader2';
const LEGACY_SCHEMA = 'v1.4c-reader2-postmatch-analysis-v11';

test('reader draft and evidence edit remain bounded; legacy retries retain their contract', async () => {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, any>> = [];
  const record = reviewFixture(),
    before = JSON.stringify(record);
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return new Response(
      JSON.stringify({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(record.postmatchReview),
              },
            ],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const response = await analyzePostmatchR2(
      'isolated-not-real-key',
      'isolated-model',
      record,
      record.postmatchEvidence!,
      {
        promptVersion: LEGACY_PROMPT,
        schemaVersion: LEGACY_SCHEMA,
      },
    );
    assert.equal(response.promptVersion, LEGACY_PROMPT);
    assert.equal(bodies[0].reasoning.effort, 'none');
    assert.equal(bodies[0].max_output_tokens, 4500);
    assert.equal(bodies[1].max_output_tokens, 3500);
    assert.ok(JSON.parse(bodies[1].input).draft);
    assert.equal(
      response.output.reader_generation_mode,
      'draft_then_evidence_edit',
    );
    assert.equal(response.meta.outputTokens, 2);
    validateR2Analysis(response.output, record.postmatchEvidence!);
    assert.ok(bodies[0].text.format.schema.required.includes('reader_review'));
    assert.equal(
      bodies[0].text.format.schema.required.includes('team_reviews'),
      false,
    );
    assert.equal(
      'factorConflictMatrix' in JSON.parse(bodies[0].input).analysis_packet,
      false,
    );
    assert.match(JSON.parse(bodies[0].input).instruction, /禁止猜测选手归属/);
    assert.match(
      JSON.parse(bodies[0].input).instruction,
      /比较→指出矛盾或差异/,
    );
    assert.match(JSON.parse(bodies[0].input).instruction, /不是数据播报/);
    const legacy = structuredClone(record.postmatchEvidence!);
    delete legacy.reviewFocus;
    delete legacy.teamOutcomes;
    delete legacy.readerInsights;
    const old = await analyzePostmatchR2(
      'isolated-not-real-key',
      'isolated-model',
      record,
      legacy,
      {
        promptVersion: 'vct-postmatch-deepseek-v4-r2.1',
        schemaVersion: 'v1.4c-r2-postmatch-analysis-v1',
      },
    );
    assert.equal(old.promptVersion, 'vct-postmatch-deepseek-v4-r2.1');
    assert.equal(bodies[2].max_output_tokens, 2800);
    assert.equal(bodies[2].reasoning.effort, 'none');
    assert.equal(
      bodies[2].text.format.schema.required.includes('team_reviews'),
      false,
    );
    assert.equal(JSON.stringify(record), before);
    await analyzePostmatchR2(
      'isolated-not-real-key',
      'isolated-model',
      record,
      record.postmatchEvidence!,
      {
        promptVersion: LEGACY_PROMPT,
        schemaVersion: LEGACY_SCHEMA,
        attemptCount: 2,
      },
    );
    assert.equal(bodies[3].reasoning.effort, 'none');
    assert.equal(bodies[3].max_output_tokens, 4500);
    assert.deepEqual(
      JSON.parse(bodies[3].input),
      JSON.parse(bodies[0].input),
      'fallback must use identical evidence and writing instruction',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('explicit editorial trial plans from evidence before writing; default automatic contract stays unchanged', async () => {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, any>> = [];
  const record = reviewFixture(),
    packet = record.postmatchEvidence!,
    before = JSON.stringify(record);
  const plan = {
    thesis: '选手资料不足，不编造原因。',
    findings: [],
    maps: packet.readerInsights!.maps.map((m) => ({
      order: m.order,
      angle: '本图只确认结果。',
      limit: '缺少选手与回合过程。',
      evidence_ids: [m.reference],
    })),
  };
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify(
          bodies.length === 1 ? plan : record.postmatchReview,
        ),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const response = await analyzePostmatchR2(
      'isolated-key',
      'isolated-provider',
      record,
      packet,
      {
        promptVersion: EDITORIAL_REVIEW_PROMPT,
        schemaVersion: EDITORIAL_REVIEW_SCHEMA,
      },
    );
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].text.format.name, 'vct_postmatch_editorial_plan_v1');
    assert.equal(bodies[0].max_output_tokens, 6000);
    assert.equal(bodies[0].reasoning.effort, 'low');
    assert.equal(bodies[1].reasoning.effort, 'low');
    assert.deepEqual(
      JSON.parse(bodies[0].input).analysis_packet.teamMapTotals,
      [],
    );
    const input = JSON.parse(bodies[1].input);
    assert.deepEqual(input.editorial_plan, plan);
    assert.equal(input.draft, undefined);
    assert.match(input.instruction, /不能把同英雄比较当直接对决/);
    assert.match(input.instruction, /尚勃勒（钱包）/);
    assert.equal(
      response.output.reader_generation_mode,
      'evidence_plan_then_article',
    );
    validateR2Analysis(response.output, packet);
    assert.equal(JSON.stringify(record), before);
    assert.equal(
      POSTMATCH_JOB_PROMPT_VERSION,
      'vct-postmatch-deepseek-v18-evidence1',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('rejected evidence plan stops before article generation and retains protected diagnostic metadata', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const record = reviewFixture();
  const rejected = { thesis: 'untrusted', findings: [], maps: [] };
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify(rejected),
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        analyzePostmatchR2(
          'isolated-key',
          'isolated-provider',
          record,
          record.postmatchEvidence!,
          {
            promptVersion: EDITORIAL_REVIEW_PROMPT,
            schemaVersion: EDITORIAL_REVIEW_SCHEMA,
          },
        ),
      (error: any) => {
        assert.equal(error.message, 'schema_editorial_plan_evidence');
        assert.deepEqual(error.rejectedOutput, rejected);
        assert.equal(error.inputTokens, 5);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('prematch retries send the stored input and original prompt version, not rebuilt current fields', async () => {
  const original = globalThis.fetch;
  let body: Record<string, any> = {};
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({ output_text: JSON.stringify({ stage: 'prematch' }) }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const packet = {
      stage: 'prematch',
      official_math_probability_team_a: 0.49,
      locked_at: '2026-09-01T00:00:00Z',
    };
    const result = await analyzePrematch(
      'isolated-key',
      'isolated-provider',
      reviewFixture(),
      { packet, promptVersion: 'vct-prematch-deepseek-v2.2' },
    );
    assert.deepEqual(JSON.parse(body.input), packet);
    assert.equal(result.promptVersion, 'vct-prematch-deepseek-v2.2');
    assert.equal(body.reasoning.effort, 'none');
  } finally {
    globalThis.fetch = original;
  }
});
