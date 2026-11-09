"""Evidence-bound post-match diagnostics for resolved system predictions."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any

from .constants import MAPS
from .db import Database


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def build_prediction_review(db: Database, prediction_id: str) -> dict[str, Any]:
    db.initialize()
    with db.connect() as conn:
        row = conn.execute(
            """SELECT p.*, ta.name AS team_a_name, tb.name AS team_b_name,
                      tw.name AS predicted_winner_name, aw.name AS actual_winner_name
               FROM predictions p
               JOIN teams ta ON ta.team_id=p.team_a_id
               JOIN teams tb ON tb.team_id=p.team_b_id
               JOIN teams tw ON tw.team_id=p.predicted_winner_id
               JOIN teams aw ON aw.team_id=p.actual_winner_id
               WHERE p.prediction_id=? AND p.status='resolved'
                 AND EXISTS(SELECT 1 FROM matches m WHERE m.match_id=p.resolved_match_id AND m.series_format=p.series_format)
                 AND p.source LIKE 'system%' AND p.resolved_match_id IS NOT NULL""",
            (prediction_id,),
        ).fetchone()
        if row is None:
            raise ValueError("只有已结算的系统预测可以生成自动复盘")
        actual_rows = conn.execute(
            """SELECT map_order, map_id, team_a_rounds, team_b_rounds
               FROM map_results WHERE match_id=? ORDER BY map_order""",
            (row["resolved_match_id"],),
        ).fetchall()

    item = dict(row)
    factor_snapshot = json.loads(item["factor_snapshot_json"])
    bp_plan = json.loads(item["bp_plan_json"])
    map_probabilities = json.loads(item["map_probabilities_json"])
    predicted_ids = list(bp_plan.get("ordered_map_ids") or [])
    actual_maps = [
        {
            "map_id": result["map_id"],
            "map": MAPS.get(result["map_id"], result["map_id"]),
            "team_a_rounds": result["team_a_rounds"],
            "team_b_rounds": result["team_b_rounds"],
            "winner_id": item["team_a_id"] if result["team_a_rounds"] > result["team_b_rounds"] else item["team_b_id"],
        }
        for result in actual_rows
    ]
    predicted_maps = [
        {"map_id": map_id, "map": MAPS.get(map_id, map_id)} for map_id in predicted_ids
    ]
    actual_ids = [result["map_id"] for result in actual_rows]
    map_overlap = len(set(predicted_ids) & set(actual_ids))

    actual_a = 1.0 if item["actual_winner_id"] == item["team_a_id"] else 0.0
    probability_a = float(item["team_a_win_probability"])
    actual_probability = probability_a if actual_a else 1.0 - probability_a
    brier = (probability_a - actual_a) ** 2
    log_loss = -math.log(max(min(actual_probability, 1 - 1e-15), 1e-15))
    winner_correct = item["predicted_winner_id"] == item["actual_winner_id"]
    score_correct = item["predicted_score"] == item["actual_score"]

    explanation = factor_snapshot.get("explanation") or {}
    contributions = explanation.get("contributions") or []
    contribution_by_key = {entry.get("key"): entry for entry in contributions}
    flags: list[str] = []
    if not winner_correct:
        flags.append("winner_error")
    if not score_correct:
        flags.append("score_error")
    if len(actual_ids) and map_overlap < len(actual_ids):
        flags.append("bp_map_mismatch")
    predicted_probability = max(probability_a, 1.0 - probability_a)
    if not winner_correct and predicted_probability >= 0.65:
        flags.append("high_confidence_error")

    actual_supports_a = actual_a == 1.0
    for key, flag in (
        ("team_rating", "rating_direction_error_candidate"),
        ("player_form", "player_form_direction_error_candidate"),
        ("map_pool", "map_pool_direction_error_candidate"),
    ):
        entry = contribution_by_key.get(key) or {}
        points = float(entry.get("probability_points") or 0.0)
        wrong_direction = (actual_supports_a and points < -0.01) or (not actual_supports_a and points > 0.01)
        if wrong_direction:
            flags.append(flag)

    map_probability_by_id = {entry["map_id"]: entry for entry in map_probabilities}
    actual_map_diagnostics = []
    for actual in actual_maps:
        estimate = map_probability_by_id.get(actual["map_id"])
        actual_map_diagnostics.append({
            **actual,
            "was_in_model_order": actual["map_id"] in predicted_ids,
            "model_team_a_probability": estimate.get("team_a_probability") if estimate else None,
            "model_team_b_probability": estimate.get("team_b_probability") if estimate else None,
        })

    ranked = sorted(contributions, key=lambda entry: abs(float(entry.get("probability_points") or 0.0)), reverse=True)
    diagnostics = {
        "actual_winner_probability": round(actual_probability, 6),
        "predicted_winner_probability": round(predicted_probability, 6),
        "map_overlap_ratio": round(map_overlap / len(actual_ids), 4) if actual_ids else None,
        "actual_map_diagnostics": actual_map_diagnostics,
        "largest_contributions": ranked[:5],
        "prediction_context": factor_snapshot.get("prediction_context") or {},
        "interpretation_boundary": "变量方向是误差诊断线索，不等于已证明的因果关系，也不会自动修改模型权重。",
    }
    summary = {
        "headline": (
            f"胜者命中：{item['predicted_winner_name']}，实际 {item['actual_score']}"
            if winner_correct
            else f"胜者未命中：预测 {item['predicted_winner_name']}，实际 {item['actual_winner_name']} {item['actual_score']}"
        ),
        "model_probability": f"{item['team_a_name']} {probability_a * 100:.1f}% / {item['team_b_name']} {(1 - probability_a) * 100:.1f}%",
        "map_comparison": f"模型顺序与已进行地图重合 {map_overlap}/{len(actual_ids)}",
        "next_action": "保留冻结权重，将本场作为Rating、选手状态和BP地图偏差的诊断样本。",
    }
    result = {
        "prediction_id": prediction_id,
        "generated_at": _now(),
        "model_version": item["model_version"],
        "winner_correct": winner_correct,
        "score_correct": score_correct,
        "brier_score": round(brier, 6),
        "log_loss": round(log_loss, 6),
        "predicted_maps": predicted_maps,
        "actual_maps": actual_maps,
        "map_overlap": map_overlap,
        "flags": list(dict.fromkeys(flags)),
        "diagnostics": diagnostics,
        "summary": summary,
        "match": {
            "event": item["event"],
            "scheduled_at": item["scheduled_at"],
            "team_a": item["team_a_name"],
            "team_b": item["team_b_name"],
            "predicted_winner": item["predicted_winner_name"],
            "actual_winner": item["actual_winner_name"],
            "predicted_score": item["predicted_score"],
            "actual_score": item["actual_score"],
            "team_a_probability": probability_a,
            "team_b_probability": 1.0 - probability_a,
        },
    }
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO prediction_reviews(
                   prediction_id, generated_at, model_version, winner_correct, score_correct,
                   brier_score, log_loss, predicted_maps_json, actual_maps_json,
                   map_overlap, flags_json, diagnostics_json, summary_json
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(prediction_id) DO UPDATE SET
                   generated_at=excluded.generated_at, model_version=excluded.model_version,
                   winner_correct=excluded.winner_correct, score_correct=excluded.score_correct,
                   brier_score=excluded.brier_score, log_loss=excluded.log_loss,
                   predicted_maps_json=excluded.predicted_maps_json,
                   actual_maps_json=excluded.actual_maps_json, map_overlap=excluded.map_overlap,
                   flags_json=excluded.flags_json, diagnostics_json=excluded.diagnostics_json,
                   summary_json=excluded.summary_json""",
            (
                prediction_id, result["generated_at"], item["model_version"], int(winner_correct), int(score_correct),
                result["brier_score"], result["log_loss"], _json(predicted_maps), _json(actual_maps),
                map_overlap, _json(result["flags"]), _json(diagnostics), _json(summary),
            ),
        )
    return result


def refresh_prediction_reviews(db: Database) -> dict[str, int]:
    db.initialize()
    with db.connect() as conn:
        ids = [row[0] for row in conn.execute(
            """SELECT prediction_id FROM predictions
               WHERE status='resolved' AND source LIKE 'system%' AND resolved_match_id IS NOT NULL
                 AND EXISTS(SELECT 1 FROM matches m WHERE m.match_id=predictions.resolved_match_id AND m.series_format=predictions.series_format)
               ORDER BY julianday(scheduled_at)"""
        ).fetchall()]
    generated = 0
    for prediction_id in ids:
        build_prediction_review(db, prediction_id)
        generated += 1
    return {"reviews_generated": generated}


def list_prediction_reviews(db: Database) -> list[dict[str, Any]]:
    refresh_prediction_reviews(db)
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT r.*, p.event, p.scheduled_at, p.predicted_score, p.actual_score,
                      p.team_a_win_probability, p.team_b_win_probability,
                      ta.name AS team_a_name, tb.name AS team_b_name,
                      tw.name AS predicted_winner_name, aw.name AS actual_winner_name
               FROM prediction_reviews r
               JOIN predictions p ON p.prediction_id=r.prediction_id
               JOIN teams ta ON ta.team_id=p.team_a_id
               JOIN teams tb ON tb.team_id=p.team_b_id
               JOIN teams tw ON tw.team_id=p.predicted_winner_id
               JOIN teams aw ON aw.team_id=p.actual_winner_id
               WHERE EXISTS(SELECT 1 FROM matches m WHERE m.match_id=p.resolved_match_id AND m.series_format=p.series_format)
               ORDER BY julianday(p.scheduled_at) DESC"""
        ).fetchall()
    reviews = []
    for row in rows:
        item = dict(row)
        for key in ("predicted_maps", "actual_maps", "flags", "diagnostics", "summary"):
            item[key] = json.loads(item.pop(f"{key}_json"))
        item["winner_correct"] = bool(item["winner_correct"])
        item["score_correct"] = bool(item["score_correct"])
        reviews.append(item)
    return reviews
