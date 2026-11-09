"""Compatibility of frozen predictions with observed results; never rewrite either."""
from __future__ import annotations

import re
import json
from datetime import datetime

QUARANTINE_VERSION = "result-comparison-quarantine-v1"


def comparison_issue(frozen_format, observed_format, score):
    if observed_format not in {"bo3", "bo5"}:
        return "canonical_result_format_unavailable"
    if frozen_format != observed_format:
        return "prediction_result_series_format_mismatch"
    match = re.fullmatch(r"(\d+)-(\d+)", str(score or ""))
    if not match:
        return "invalid_canonical_series_score"
    a, b = int(match[1]), int(match[2])
    needed = 3 if observed_format == "bo5" else 2
    if max(a, b) != needed or min(a, b) >= needed:
        return "invalid_canonical_series_score"
    return None


def quarantined_results(connection):
    rows = connection.execute("""SELECT p.prediction_id,p.fixture_id,p.series_format frozen_format,
        p.actual_score,p.team_a_win_probability,p.locked_at,p.resolved_match_id,
        m.series_format observed_format,m.source_url,m.inserted_at,
        ta.name team_a,tb.name team_b
        FROM predictions p LEFT JOIN matches m ON m.match_id=p.resolved_match_id
        JOIN teams ta ON ta.team_id=p.team_a_id JOIN teams tb ON tb.team_id=p.team_b_id
        WHERE p.source LIKE 'system%' AND p.status='resolved'"""
    ).fetchall()
    result = []
    for row in rows:
        row = dict(row)
        reason = comparison_issue(row['frozen_format'], row['observed_format'], row['actual_score'])
        if reason:
            result.append({"schema_version": QUARANTINE_VERSION, "status": "QUARANTINED",
                           "reason": reason, **row, "evaluation_allowed": False})
    return result


def reconcile_confirmed_results(db):
    """Settle existing locks from their exact fixture; never replay Rating updates."""
    from .sources.vlr import validate_series_finality
    recovered, blocked = [], []
    with db.connect() as connection:
        rows = connection.execute("""SELECT p.prediction_id,p.locked_at,p.scheduled_at,p.series_format frozen_format,
            p.team_a_id prediction_a,p.team_b_id prediction_b,f.external_match_id,m.*,
            r.status candidate_status,r.confirmation_count,r.candidate_json,r.last_seen_at
            FROM predictions p JOIN fixtures f ON f.fixture_id=p.fixture_id
            JOIN matches m ON m.match_id=f.completed_match_id
            JOIN result_candidates r ON r.source_id=f.source_id AND r.external_match_id=f.external_match_id
            WHERE p.status='locked' AND p.source LIKE 'system%'""").fetchall()
        for row in rows:
            row = dict(row)
            reason = None
            candidate = json.loads(row['candidate_json'])
            maps = [dict(m) for m in connection.execute('SELECT * FROM map_results WHERE match_id=? ORDER BY map_order',(row['match_id'],))]
            facts = {key: row[key] for key in ('series_format','team_a_id','team_b_id','team_a_maps','team_b_maps','winner_id')}
            candidate_maps = [{**{k:m[k] for k in ('map_order','team_a_rounds','team_b_rounds')},'map':m['map_id']} for m in maps]
            score = f"{row['team_a_maps']}-{row['team_b_maps']}"
            def at(value): return datetime.fromisoformat(value.replace('Z','+00:00'))
            if row['candidate_status'] != 'FINAL_CONFIRMED' or row['confirmation_count'] < 2:
                reason = 'awaiting_stable_result'
            elif any(candidate.get(k) != v for k,v in facts.items()) or candidate.get('maps') != candidate_maps:
                reason = 'source_canonical_result_conflict'
            elif (row['prediction_a'],row['prediction_b']) != (row['team_a_id'],row['team_b_id']):
                reason = 'prediction_result_team_identity_conflict'
            elif comparison_issue(row['frozen_format'],row['series_format'],score):
                reason = comparison_issue(row['frozen_format'],row['series_format'],score)
            elif not at(row['locked_at']) < min(at(row['scheduled_at']),at(row['played_at'])):
                reason = 'prediction_not_before_actual_match'
            else:
                finality, problem = validate_series_finality(row['series_format'],'final',
                    (row['team_a_maps'],row['team_b_maps']),maps)
                if finality != 'FINAL_CANDIDATE': reason = problem or finality
            if reason:
                blocked.append({'prediction_id':row['prediction_id'],'reason':reason})
                continue
            connection.execute("""UPDATE predictions SET status='resolved',actual_winner_id=?,actual_score=?,resolved_match_id=?
                WHERE prediction_id=? AND status='locked'""",(row['winner_id'],score,row['match_id'],row['prediction_id']))
            recovered.append({'schema_version':'confirmed-settlement-recovery-v1','prediction_id':row['prediction_id'],
                'match_id':row['match_id'],'previous_status':'locked','actual_winner_id':row['winner_id'],
                'actual_score':score,'confirmed_at':row['last_seen_at'],'frozen_at':row['locked_at'],
                'frozen_prediction_changed':False,'rating_reprocessed':False})
    return {'settlements_recovered':len(recovered),'recovered':recovered,'blocked':blocked}
