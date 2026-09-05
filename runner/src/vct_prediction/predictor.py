"""把总体实力、近期状态、地图与可解释因子组合成赛前锁定预测。"""

from __future__ import annotations

import json
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from . import MODEL_VERSION
from .constants import MAPS, SERIES_FORMATS, normalize_map
from .db import Database
from .form import recent_form_score
from .maps import estimate_map, plan_bp, series_distribution
from .math_utils import logistic_rating, parse_timestamp, patch_distance, probability_with_adjustments


EXPLANATION_FEATURES = (
    "team_rating",
    "map_pool",
    "recent_form",
    "player_form",
    "roster_continuity",
    "patch_fit",
    "international_experience",
    "series_adaptability",
    "tactical_matchup",
)


def _effective_rating(team: dict[str, Any], patch: str | None, base: float) -> tuple[float, dict[str, float]]:
    roster_reliability = 0.55 + 0.45 * float(team["roster_continuity"])
    version_reliability = math.exp(-0.08 * patch_distance(team.get("last_patch"), patch))
    reliability = roster_reliability * version_reliability
    effective = base + (float(team["rating"]) - base) * reliability
    return effective, {
        "raw": round(float(team["rating"]), 4),
        "effective": round(effective, 4),
        "roster_reliability": round(roster_reliability, 4),
        "patch_reliability": round(version_reliability, 4),
    }


def _factor_value(team: dict[str, Any], name: str, overrides: dict[str, float]) -> float:
    if name in overrides:
        return float(overrides[name])
    return float(team[name])


def _series_win_probability(probabilities: list[float], series_format: str) -> float:
    distribution = series_distribution(probabilities, series_format)
    wins_needed = SERIES_FORMATS[series_format]
    return sum(
        probability
        for score, probability in distribution.items()
        if int(score.split("-", 1)[0]) == wins_needed
    )


def _build_explanation(
    *,
    ordered_ids: list[str],
    estimate_by_id: dict[str, Any],
    series_format: str,
    base_rating: float,
    elo_scale: float,
    effective_a: float,
    effective_b: float,
    factor_values: dict[str, dict[str, Any]],
    factor_differences: dict[str, float],
    weights: dict[str, float],
) -> dict[str, Any]:
    """以固定 BP 顺序对最终系列赛胜率做精确 Shapley 分解。"""
    feature_index = {key: index for index, key in enumerate(EXPLANATION_FEATURES)}
    feature_count = len(EXPLANATION_FEATURES)
    cache: dict[int, float] = {}

    def probability(mask: int) -> float:
        cached = cache.get(mask)
        if cached is not None:
            return cached
        map_probabilities: list[float] = []
        for map_id in ordered_ids:
            estimate = estimate_by_id[map_id]
            rating_a = base_rating
            rating_b = base_rating
            if mask & (1 << feature_index["team_rating"]):
                rating_a += effective_a - base_rating
                rating_b += effective_b - base_rating
            if mask & (1 << feature_index["map_pool"]):
                rating_a += float(estimate.rating_a) - effective_a
                rating_b += float(estimate.rating_b) - effective_b
            base_probability = logistic_rating(rating_a - rating_b, elo_scale)
            adjustments = [
                float(weights[key]) * 0.65 * float(factor_differences[key])
                for key in factor_differences
                if mask & (1 << feature_index[key])
            ]
            map_probabilities.append(probability_with_adjustments(base_probability, adjustments))
        value = _series_win_probability(map_probabilities, series_format)
        cache[mask] = value
        return value

    all_mask = (1 << feature_count) - 1
    shapley: dict[str, float] = {}
    for key, index in feature_index.items():
        bit = 1 << index
        contribution = 0.0
        for mask in range(1 << feature_count):
            if mask & bit:
                continue
            subset_size = mask.bit_count()
            coefficient = 1.0 / (feature_count * math.comb(feature_count - 1, subset_size))
            contribution += coefficient * (probability(mask | bit) - probability(mask))
        shapley[key] = contribution

    map_offsets_a = [float(estimate_by_id[map_id].rating_a) - effective_a for map_id in ordered_ids]
    map_offsets_b = [float(estimate_by_id[map_id].rating_b) - effective_b for map_id in ordered_ids]
    average_offset_a = sum(map_offsets_a) / len(map_offsets_a)
    average_offset_b = sum(map_offsets_b) / len(map_offsets_b)
    raw_inputs: dict[str, dict[str, Any]] = {
        "team_rating": {
            "team_a": effective_a,
            "team_b": effective_b,
            "difference": effective_a - effective_b,
            "coefficient": None,
            "applied_coefficient": None,
            "log_odds_adjustment": math.log(10.0) * (effective_a - effective_b) / elo_scale,
            "unit": "rating_points",
            "active": True,
        },
        "map_pool": {
            "team_a": average_offset_a,
            "team_b": average_offset_b,
            "difference": average_offset_a - average_offset_b,
            "coefficient": None,
            "applied_coefficient": None,
            "log_odds_adjustment": math.log(10.0) * (average_offset_a - average_offset_b) / elo_scale,
            "unit": "rating_offset",
            "active": True,
        },
    }
    for key, values in factor_values.items():
        coefficient = float(weights[key])
        raw_inputs[key] = {
            "team_a": values["team_a"],
            "team_b": values["team_b"],
            "difference": factor_differences[key],
            "coefficient": coefficient,
            "applied_coefficient": coefficient * 0.65,
            "log_odds_adjustment": coefficient * 0.65 * factor_differences[key],
            "unit": "normalized",
            "active": values.get("active", True),
        }

    absolute_total = sum(abs(value) for value in shapley.values())
    ranked_keys = sorted(EXPLANATION_FEATURES, key=lambda key: abs(shapley[key]), reverse=True)
    rank_by_key = {key: index + 1 for index, key in enumerate(ranked_keys)}
    contributions = []
    for key in EXPLANATION_FEATURES:
        contribution = shapley[key]
        inputs = raw_inputs[key]
        contributions.append({
            "key": key,
            "rank": rank_by_key[key],
            "team_a_value": round(float(inputs["team_a"]), 6),
            "team_b_value": round(float(inputs["team_b"]), 6),
            "difference_a_minus_b": round(float(inputs["difference"]), 6),
            "coefficient": None if inputs["coefficient"] is None else round(float(inputs["coefficient"]), 6),
            "applied_coefficient": None if inputs["applied_coefficient"] is None else round(float(inputs["applied_coefficient"]), 6),
            "log_odds_adjustment": round(float(inputs["log_odds_adjustment"]), 6),
            "probability_points": round(contribution * 100.0, 6),
            "absolute_share": round(abs(contribution) / absolute_total if absolute_total else 0.0, 6),
            "direction": "team_a" if contribution > 1e-12 else "team_b" if contribution < -1e-12 else "neutral",
            "unit": inputs["unit"],
            "active": bool(inputs["active"]),
        })

    rating_mask = 1 << feature_index["team_rating"]
    map_mask = 1 << feature_index["map_pool"]
    return {
        "available": True,
        "method": "exact_shapley_probability_points",
        "condition": "fixed_selected_bp_order",
        "neutral_probability_a": round(probability(0), 6),
        "rating_only_probability_a": round(probability(rating_mask), 6),
        "rating_map_probability_a": round(probability(rating_mask | map_mask), 6),
        "final_probability_a": round(probability(all_mask), 6),
        "total_shift_probability_points": round((probability(all_mask) - probability(0)) * 100.0, 6),
        "contribution_sum_probability_points": round(sum(shapley.values()) * 100.0, 6),
        "ordered_map_ids": ordered_ids,
        "contributions": contributions,
        "notes": [
            "绝对解释占比按各变量 Shapley 概率贡献的绝对值归一化，方向由正负号表示。",
            "贡献基于当前已选 BP 与地图顺序；BP 本身作为结构条件，不单独分配因果占比。",
            "Team Rating 已先经过阵容连续性和 Patch 可靠性衰减。",
        ],
    }


def predict_match(
    db: Database,
    *,
    team_a_id: str,
    team_b_id: str,
    scheduled_at: str,
    event: str,
    region: str,
    patch: str | None,
    series_format: str,
    map_pool: list[str],
    known_maps: list[str] | None = None,
    is_international: bool = False,
    team_a_overrides: dict[str, float] | None = None,
    team_b_overrides: dict[str, float] | None = None,
    tactical_matchup_a: float = 0.0,
    source: str = "system",
    locked_at: str | None = None,
    fixture_id: str | None = None,
    lock_policy: str = "manual",
    prediction_context: dict[str, Any] | None = None,
    persist: bool = True,
) -> dict[str, Any]:
    if series_format not in SERIES_FORMATS:
        raise ValueError("series_format 必须为 bo3 或 bo5")
    if team_a_id == team_b_id:
        raise ValueError("比赛双方不能是同一队")
    if not -1.0 <= tactical_matchup_a <= 1.0:
        raise ValueError("tactical_matchup_a 必须在 [-1, 1]")
    map_pool_ids = list(dict.fromkeys(normalize_map(item) for item in map_pool))
    known_map_ids = [normalize_map(item) for item in known_maps] if known_maps else None
    required = SERIES_FORMATS[series_format] * 2 - 1
    if len(map_pool_ids) < required:
        raise ValueError(f"{series_format.upper()} 至少需要 {required} 张地图")
    if known_map_ids and len(known_map_ids) < required:
        raise ValueError(f"已知地图顺序至少需要 {required} 张")

    config = db.config()
    weights = config["weights"]
    team_a = db.team_context_as_of(team_a_id, scheduled_at)
    team_b = db.team_context_as_of(team_b_id, scheduled_at)
    override_a = team_a_overrides or {}
    override_b = team_b_overrides or {}
    base = float(config["base_rating"])
    effective_a, rating_a_detail = _effective_rating(team_a, patch, base)
    effective_b, rating_b_detail = _effective_rating(team_b, patch, base)
    rating_probability_a = logistic_rating(effective_a - effective_b, float(config["elo_scale"]))

    form_a, form_a_detail = recent_form_score(db, team_a_id, scheduled_at, patch, config)
    form_b, form_b_detail = recent_form_score(db, team_b_id, scheduled_at, patch, config)
    player_form_a, player_form_a_detail = db.player_form_as_of(team_a_id, scheduled_at)
    player_form_b, player_form_b_detail = db.player_form_as_of(team_b_id, scheduled_at)
    player_form_a = _factor_value(team_a, "player_form", override_a) if player_form_a is None else player_form_a
    player_form_b = _factor_value(team_b, "player_form", override_b) if player_form_b is None else player_form_b
    factor_values = {
        "recent_form": {"team_a": form_a, "team_b": form_b},
        "player_form": {"team_a": player_form_a, "team_b": player_form_b},
        "roster_continuity": {
            "team_a": _factor_value(team_a, "roster_continuity", override_a),
            "team_b": _factor_value(team_b, "roster_continuity", override_b),
        },
        "patch_fit": {
            "team_a": _factor_value(team_a, "patch_fit", override_a),
            "team_b": _factor_value(team_b, "patch_fit", override_b),
        },
        "international_experience": {
            "team_a": _factor_value(team_a, "international_experience", override_a),
            "team_b": _factor_value(team_b, "international_experience", override_b),
            "active": is_international,
        },
        "series_adaptability": {
            "team_a": _factor_value(team_a, f"{series_format}_adaptability", override_a),
            "team_b": _factor_value(team_b, f"{series_format}_adaptability", override_b),
        },
        "tactical_matchup": {"team_a": tactical_matchup_a, "team_b": 0.0},
    }
    factor_differences = {
        "recent_form": form_a - form_b,
        "player_form": player_form_a - player_form_b,
        "roster_continuity": factor_values["roster_continuity"]["team_a"] - factor_values["roster_continuity"]["team_b"],
        "patch_fit": factor_values["patch_fit"]["team_a"] - factor_values["patch_fit"]["team_b"],
        "international_experience": (
            factor_values["international_experience"]["team_a"]
            - factor_values["international_experience"]["team_b"]
        ) if is_international else 0.0,
        "series_adaptability": (
            factor_values["series_adaptability"]["team_a"]
            - factor_values["series_adaptability"]["team_b"]
        ),
        "tactical_matchup": tactical_matchup_a,
    }
    adjustments = [float(weights[name]) * difference for name, difference in factor_differences.items()]
    # 地图是比赛胜率的主干；通用因子仅以 65% 强度进入每张地图，避免重复覆盖地图证据。
    map_adjustments = [value * 0.65 for value in adjustments]
    map_team_a = {**team_a, "rating": effective_a}
    map_team_b = {**team_b, "rating": effective_b}
    estimates = [estimate_map(db, map_team_a, map_team_b, map_id, map_adjustments, config) for map_id in map_pool_ids]
    estimate_by_id = {item.map_id: item for item in estimates}

    if known_map_ids:
        if not set(known_map_ids).issubset(estimate_by_id):
            raise ValueError("known_maps 必须全部包含在 map_pool 中")
        ordered_ids = known_map_ids[:required]
        bp_plan = {"mode": "official_or_user_order", "actions": [], "ordered_map_ids": ordered_ids}
    else:
        bp_plan = {"mode": "model_optimal_baseline", **plan_bp(estimates, series_format)}
        ordered_ids = bp_plan["ordered_map_ids"]
    probabilities = [estimate_by_id[map_id].probability_a for map_id in ordered_ids]
    distribution = series_distribution(probabilities, series_format)
    team_a_probability = sum(prob for score, prob in distribution.items() if int(score.split("-")[0]) == SERIES_FORMATS[series_format])
    predicted_score = max(distribution, key=distribution.get)
    predicted_winner = team_a_id if team_a_probability >= 0.5 else team_b_id
    now = locked_at or datetime.now(timezone.utc).isoformat()
    if parse_timestamp(now, "locked_at") > parse_timestamp(scheduled_at, "scheduled_at"):
        raise ValueError("locked_at 不能晚于 scheduled_at；赛后预测不得作为赛前锁定记录")
    prediction_id = str(uuid.uuid4())

    explanation = _build_explanation(
        ordered_ids=ordered_ids,
        estimate_by_id=estimate_by_id,
        series_format=series_format,
        base_rating=base,
        elo_scale=float(config["elo_scale"]),
        effective_a=effective_a,
        effective_b=effective_b,
        factor_values=factor_values,
        factor_differences=factor_differences,
        weights=weights,
    )

    factor_snapshot = {
        "rating": {"team_a": rating_a_detail, "team_b": rating_b_detail, "base_probability_a": round(rating_probability_a, 6)},
        "recent_form": {"team_a": form_a_detail, "team_b": form_b_detail},
        "player_form": {"team_a": player_form_a_detail, "team_b": player_form_b_detail},
        "factor_values": factor_values,
        "factor_differences_a_minus_b": {key: round(value, 6) for key, value in factor_differences.items()},
        "log_odds_adjustments": {key: round(float(weights[key]) * value, 6) for key, value in factor_differences.items()},
        "team_a_roster_version": team_a["roster_version"],
        "team_b_roster_version": team_b["roster_version"],
        "model_config": config,
        "prediction_context": prediction_context or {},
        "explanation": explanation,
    }
    map_probabilities = [
        {
            "map_id": map_id,
            "map": MAPS[map_id],
            "team_a_probability": round(estimate_by_id[map_id].probability_a, 6),
            "team_b_probability": round(1 - estimate_by_id[map_id].probability_a, 6),
            "team_a_map_rating": round(estimate_by_id[map_id].rating_a, 2),
            "team_b_map_rating": round(estimate_by_id[map_id].rating_b, 2),
            "samples": [estimate_by_id[map_id].samples_a, estimate_by_id[map_id].samples_b],
        }
        for map_id in ordered_ids
    ]
    result = {
        "prediction_id": prediction_id,
        "model_version": MODEL_VERSION,
        "source": source,
        "fixture_id": fixture_id,
        "lock_policy": lock_policy,
        "locked_at": now,
        "scheduled_at": scheduled_at,
        "event": event,
        "region": region,
        "patch": patch,
        "series_format": series_format,
        "team_a": {"team_id": team_a_id, "name": team_a["name"], "win_probability": round(team_a_probability, 6)},
        "team_b": {"team_id": team_b_id, "name": team_b["name"], "win_probability": round(1 - team_a_probability, 6)},
        "predicted_winner_id": predicted_winner,
        "predicted_score": predicted_score,
        "score_distribution": {key: round(value, 6) for key, value in distribution.items()},
        "map_probabilities": map_probabilities,
        "bp_plan": bp_plan,
        "factor_snapshot": factor_snapshot,
        "explanation": explanation,
    }
    if persist:
        _persist_prediction(db, result)
    return result


def _persist_prediction(db: Database, result: dict[str, Any]) -> None:
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO predictions(
                   prediction_id, source, model_version, locked_at, scheduled_at, event, region, patch,
                   series_format, team_a_id, team_b_id, predicted_winner_id,
                   team_a_win_probability, team_b_win_probability, predicted_score,
                   score_distribution_json, map_probabilities_json, factor_snapshot_json, bp_plan_json,
                   fixture_id, lock_policy
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                result["prediction_id"], result["source"], result["model_version"], result["locked_at"],
                result["scheduled_at"], result["event"], result["region"], result["patch"], result["series_format"],
                result["team_a"]["team_id"], result["team_b"]["team_id"], result["predicted_winner_id"],
                result["team_a"]["win_probability"], result["team_b"]["win_probability"], result["predicted_score"],
                json.dumps(result["score_distribution"], ensure_ascii=False),
                json.dumps(result["map_probabilities"], ensure_ascii=False),
                json.dumps(result["factor_snapshot"], ensure_ascii=False),
                json.dumps(result["bp_plan"], ensure_ascii=False),
                result.get("fixture_id"), result.get("lock_policy", "manual"),
            ),
        )
