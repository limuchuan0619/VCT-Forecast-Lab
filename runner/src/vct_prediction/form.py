"""近期状态：赛果 × 对手强度 × 比分质量 × 时间/版本/阵容衰减。"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any

from .db import Database
from .math_utils import clamp, logistic_rating, parse_timestamp, patch_distance
from .ratings import score_quality


def recent_form_score(
    db: Database,
    team_id: str,
    as_of: str,
    target_patch: str | None,
    config: dict[str, Any],
) -> tuple[float, dict[str, Any]]:
    as_of_dt = parse_timestamp(as_of, "as_of")
    window_start = as_of_dt - timedelta(days=int(config["form_window_days"]))
    rows = db.recent_matches(team_id, as_of, window_start.isoformat())
    if not rows:
        return 0.0, {"matches": 0, "weighted_score": 0.0, "effective_weight": 0.0}

    base_rating = float(config["base_rating"])
    scale = float(config["elo_scale"])
    half_life = float(config["form_half_life_days"])
    weighted_sum = 0.0
    total_weight = 0.0
    details: list[dict[str, Any]] = []
    team = db.team_context_as_of(team_id, as_of)

    for row in rows:
        is_a = row["team_a_id"] == team_id
        team_rating = float(row["historical_team_a_rating"] if is_a else row["historical_team_b_rating"])
        opponent_rating = float(row["historical_team_b_rating"] if is_a else row["historical_team_a_rating"])
        expected = logistic_rating(team_rating - opponent_rating, scale)
        round_margin_a = int(row["signed_round_margin"])
        actual_a = score_quality(row["team_a_maps"], row["team_b_maps"], round_margin_a)
        actual = actual_a if is_a else 1.0 - actual_a
        # 对手质量显式影响表现强度；同时保留相对预期残差，避免刷弱队。
        opponent_quality = clamp(0.65 + (opponent_rating - base_rating) / 600.0, 0.35, 1.35)
        residual = actual - expected

        played_dt = parse_timestamp(row["played_at"], "played_at")
        age_days = max((as_of_dt - played_dt).total_seconds() / 86400.0, 0.0)
        time_decay = 0.5 ** (age_days / half_life)
        version_decay = math.exp(-0.30 * patch_distance(row["patch"], target_patch))
        roster_version_at_match = row["team_a_roster_version"] if is_a else row["team_b_roster_version"]
        roster_decay = 1.0 if not roster_version_at_match or roster_version_at_match == team["roster_version"] else max(0.35, team["roster_continuity"] * 0.75)
        weight = time_decay * version_decay * roster_decay
        contribution = residual * opponent_quality
        weighted_sum += contribution * weight
        total_weight += weight
        details.append({
            "match_id": row["match_id"],
            "opponent_quality": round(opponent_quality, 4),
            "performance_residual": round(residual, 4),
            "time_decay": round(time_decay, 4),
            "patch_decay": round(version_decay, 4),
            "roster_decay": round(roster_decay, 4),
        })

    score = clamp((weighted_sum / total_weight) * 2.0 if total_weight else 0.0, -1.0, 1.0)
    return score, {
        "matches": len(rows),
        "weighted_score": round(score, 6),
        "effective_weight": round(total_weight, 4),
        "components": details,
    }
