import type { ChallengerPublicState } from './vct-types.ts';

export const SETTLEMENT_SCHEMA_VERSION = 'v1.4c-r2.3-shadow-settlement-v1';
export type EvaluationIntegrity = {
  status: 'TRUSTED' | 'DEGRADED' | 'UNVERIFIED'; checkedMatches: number; validMatches: number;
  invalidMatches: number; reasons: string[];
};

export function checkEvaluationIntegrity(rows: Record<string, unknown>[], runner: ChallengerPublicState | null): EvaluationIntegrity {
  const invalid: string[] = [];
  const pairs: Array<{ champion: number; c1: number; outcome: number }> = [];
  const seen = new Set<string>();
  const close = (left: unknown, right: number) => typeof left === 'number' && Number.isFinite(left) && Math.abs(left - right) <= 1e-9;
  for (const row of rows) {
    const winner = row.canonical_winner;
    const champion = Number(row.champion_probability), c1 = Number(row.challenger_probability);
    if (seen.has(String(row.fixture_id))) { invalid.push('duplicate_fixture'); continue; }
    seen.add(String(row.fixture_id));
    if (row.canonical_status !== 'resolved' || !String(row.canonical_source).startsWith('system')
      || ![row.team_a, row.team_b].includes(winner) || !winner || row.actual_winner !== winner
      || !close(row.canonical_probability, champion)
      || Date.parse(String(row.frozen_at)) !== Date.parse(String(row.canonical_locked_at))
      || Date.parse(String(row.scheduled_at)) !== Date.parse(String(row.canonical_scheduled_at))
      || !(Date.parse(String(row.frozen_at)) < Date.parse(String(row.scheduled_at)))
      || !Number.isFinite(c1) || c1 < 0 || c1 > 1 || champion < 0 || champion > 1) {
      invalid.push('frozen_pair_or_result_mismatch'); continue;
    }
    const outcome = Number(winner === row.team_a);
    const loss = (p: number) => -Math.log(Math.min(Math.max(outcome ? p : 1-p, 1e-15), 1-1e-15));
    if (!close(row.champion_brier, (champion-outcome)**2) || !close(row.challenger_brier, (c1-outcome)**2)
      || !close(row.champion_log_loss, loss(champion)) || !close(row.challenger_log_loss, loss(c1))
      || !close(row.champion_correct, Number((champion >= .5) === Boolean(outcome)))
      || !close(row.challenger_correct, Number((c1 >= .5) === Boolean(outcome)))) {
      invalid.push('ledger_metric_mismatch'); continue;
    }
    pairs.push({ champion, c1, outcome });
  }
  const result: EvaluationIntegrity = {
    status: invalid.length ? 'DEGRADED' : 'UNVERIFIED', checkedMatches: rows.length,
    validMatches: pairs.length, invalidMatches: invalid.length, reasons: [...new Set(invalid)],
  };
  if (invalid.length) return result;
  if (!runner?.metricIntegrity || runner.metricIntegrity.status !== 'TRUSTED'
    || runner.metricIntegrity.schema_version !== SETTLEMENT_SCHEMA_VERSION || !runner.metrics) {
    result.reasons.push('runner_metric_verification_pending'); return result;
  }
  if (runner.eligibleResolvedMatches !== pairs.length) {
    result.status = 'DEGRADED'; result.reasons.push('runner_ledger_sample_count_mismatch'); return result;
  }
  if (!pairs.length) { result.reasons.push('no_resolved_pairs'); return result; }
  for (const [model, column] of [['champion', 'champion'], ['logistic_c1', 'c1']] as const) {
    const metrics = runner.metrics[model];
    const bins: Array<Array<{ p: number; y: number }>> = Array.from({ length: 10 }, () => []);
    let brier = 0, logLoss = 0, correct = 0;
    for (const pair of pairs) {
      const p = pair[column], y = pair.outcome;
      brier += (p-y)**2; logLoss -= Math.log(Math.min(Math.max(y ? p : 1-p, 1e-15), 1-1e-15));
      correct += Number((p >= .5) === Boolean(y)); bins[Math.min(9, Math.floor(p*10))].push({ p, y });
    }
    const ece = bins.reduce((sum, bin) => sum + (bin.length ? Math.abs(bin.reduce((v, pair) => v + pair.p-pair.y, 0))/pairs.length : 0), 0);
    if (!metrics || !close(metrics.brier, brier/pairs.length) || !close(metrics.log_loss, logLoss/pairs.length)
      || !close(metrics.accuracy, correct/pairs.length) || !close(metrics.ece_10_bin, ece)) {
      result.status = 'DEGRADED'; result.reasons.push('runner_ledger_aggregate_mismatch'); return result;
    }
  }
  result.status = 'TRUSTED'; return result;
}
