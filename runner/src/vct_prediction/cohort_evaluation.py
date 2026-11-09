"""Read-only diagnostics for frozen prospective C1, separated by competition."""
from __future__ import annotations

from collections import Counter, defaultdict
import json
import math
import random

from .shadow import FrozenLogisticC1, SHADOW_RESULT_SELECT, _expected_settlement, _settlement_matches, _time

VERSION = 'frozen-c1-cohort-evaluation-v1'


def _metrics(values):
    if not values:
        return None
    n = len(values)
    bins = [[] for _ in range(10)]
    for p, y in values:
        bins[min(int(p * 10), 9)].append((p, y))
    return {
        'brier': sum((p-y)**2 for p, y in values)/n,
        'log_loss': sum(-math.log(min(max(p if y else 1-p, 1e-15), 1-1e-15)) for p, y in values)/n,
        'accuracy': sum(int((p >= .5) == bool(y)) for p, y in values)/n,
        'ece_10_bin': sum(len(b)/n*abs(sum(p for p,y in b)/len(b)-sum(y for p,y in b)/len(b)) for b in bins if b),
        'high_confidence_count': sum(p >= .7 or p <= .3 for p,y in values),
    }


def evaluate_cohorts(connection, *, model=None, bootstrap_samples=500):
    model = model or FrozenLogisticC1()
    grouped, excluded = defaultdict(list), Counter()
    pending, features = Counter(), Counter()
    rows = connection.execute(SHADOW_RESULT_SELECT.replace(
        'SELECT c.*,', 'SELECT c.*,p.source prediction_source,p.region prediction_region,p.locked_at champion_locked_at, '
        's.feature_cutoff_at,s.feature_json,s.feature_status_json,s.evidence_json,'
    ).replace('LEFT JOIN matches m', 'JOIN challenger_feature_snapshots s ON s.snapshot_id=c.feature_snapshot_id LEFT JOIN matches m')
        + " ORDER BY c.scheduled_at,c.shadow_prediction_id").fetchall()
    for row in connection.execute("SELECT p.source,COUNT(*) n FROM challenger_predictions c JOIN predictions p ON p.prediction_id=c.champion_prediction_id WHERE c.status='locked' AND p.status='locked' GROUP BY p.source"):
        pending[row['source']] = row['n']
    frozen_reproduced = 0
    for row in rows:
        key = 'primary_vct' if row['eligible'] else row['prediction_source'].removeprefix('system_auto_') + ':' + row['prediction_region']
        try:
            if row['record_kind'] != 'real_prospective' or row['data_quality_state'] not in {'ready','locked'}:
                raise ValueError('not_real_ready_prospective')
            if row['artifact_hash'] != model.artifact_hash or row['challenger_model_id'] != model.model_id:
                raise ValueError('frozen_artifact_identity_mismatch')
            if _time(row['frozen_at']) != _time(row['champion_locked_at']):
                raise ValueError('champion_shadow_freeze_mismatch')
            if not (_time(row['feature_cutoff_at']) <= _time(row['frozen_at']) < _time(row['scheduled_at'])):
                raise ValueError('feature_cutoff_not_prematch')
            evidence = json.loads(row['evidence_json'])
            if evidence.get('max_source_time') and not _time(evidence['max_source_time']) < _time(row['feature_cutoff_at']):
                raise ValueError('source_time_not_before_cutoff')
            reproduced = model.predict(json.loads(row['feature_json']),json.loads(row['feature_status_json']))
            if not math.isclose(reproduced,float(row['challenger_probability']),abs_tol=1e-10,rel_tol=0):
                raise ValueError('frozen_probability_not_reproducible')
            frozen_reproduced += 1
            expected = _expected_settlement(row)
            if row['status'] != 'resolved' or not _settlement_matches(row, expected):
                raise ValueError('settlement_not_verified')
            grouped[key].append(dict(row))
            features.update(json.loads(row['feature_status_json']).values())
        except ValueError as exc:
            excluded[key + ':' + str(exc)] += 1
    cohorts = []
    for key, group in sorted(grouped.items()):
        n = len(group)
        ys = [int(r['actual_winner_id'] == r['team_a_id']) for r in group]
        a = [float(r['champion_probability']) for r in group]
        b = [float(r['challenger_probability']) for r in group]
        deltas = [(pb-y)**2-(pa-y)**2 for pa,pb,y in zip(a,b,ys)]
        rng = random.Random(20261104)
        samples = sorted(sum(rng.choice(deltas) for _ in range(n))/n for _ in range(bootstrap_samples))
        cohorts.append({'cohort':key,'matches':n,'started_at':group[0]['scheduled_at'],'ended_at':group[-1]['scheduled_at'],
            'champion':_metrics(list(zip(a,ys))),'c1':_metrics(list(zip(b,ys))),
            'c1_minus_champion_brier':sum(deltas)/n,
            'paired_bootstrap_95_percent':[samples[int(.025*(len(samples)-1))],samples[int(.975*(len(samples)-1))]],
            'verdict':'PRELIMINARY_NO_PROMOTION_DECISION',
            'primary_gate_contribution':n if key=='primary_vct' else 0})
    return {'schema_version':VERSION,'model_id':model.model_id,'artifact_hash':model.artifact_hash,
        'frozen_probabilities_reproduced':frozen_reproduced,'valid_resolved_matches':sum(len(g) for g in grouped.values()),
        'cohorts':cohorts,'excluded':dict(excluded),'pending':dict(pending),'feature_status_counts':dict(features),
        'retrained':False,'promotion_enabled':False,'historical_test_included':False}
