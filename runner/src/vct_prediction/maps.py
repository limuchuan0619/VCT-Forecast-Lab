"""独立地图池评分、BP 规划与系列赛比分分布。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .constants import MAPS, SERIES_FORMATS, normalize_map
from .db import Database
from .math_utils import logistic_rating, probability_with_adjustments


@dataclass(frozen=True)
class MapEstimate:
    map_id: str
    probability_a: float
    rating_a: float
    rating_b: float
    samples_a: int
    samples_b: int


def estimate_map(
    db: Database,
    team_a: dict[str, Any],
    team_b: dict[str, Any],
    map_id: str,
    adjustments: list[float],
    config: dict[str, Any],
) -> MapEstimate:
    map_id = normalize_map(map_id)
    prior = float(config["map_prior_matches"])
    base = float(config["base_rating"])

    def shrunk(team: dict[str, Any]) -> tuple[float, int]:
        row = db.fetch_map_rating(team["team_id"], map_id)
        if not row:
            return float(team["rating"]), 0
        n = int(row["matches_played"])
        # 地图 Rating 向总体 Team Rating 收缩；样本越多，地图自身权重越高。
        rating = (float(row["rating"]) * n + float(team["rating"]) * prior) / (n + prior)
        return rating, n

    rating_a, samples_a = shrunk(team_a)
    rating_b, samples_b = shrunk(team_b)
    base_probability = logistic_rating(rating_a - rating_b, float(config["elo_scale"]))
    probability = probability_with_adjustments(base_probability, adjustments)
    return MapEstimate(map_id, probability, rating_a, rating_b, samples_a, samples_b)


def plan_bp(map_estimates: list[MapEstimate], series_format: str) -> dict[str, Any]:
    """
    生成可解释的“理性 BP”基线。

    赛事实际 veto 次序可能不同；若已知官方 BP，应直接将有序地图传给预测器。
    """
    if series_format not in SERIES_FORMATS:
        raise ValueError("仅支持 bo3 或 bo5")
    required_maps = 3 if series_format == "bo3" else 5
    if len(map_estimates) < required_maps:
        raise ValueError(f"{series_format.upper()} 至少需要 {required_maps} 张候选地图")
    remaining = list(map_estimates)
    actions: list[dict[str, str]] = []

    def remove(estimate: MapEstimate, action: str, team: str) -> None:
        remaining.remove(estimate)
        actions.append({"action": action, "team": team, "map_id": estimate.map_id, "map": MAPS[estimate.map_id]})

    # VCT 通常以七图池进行 BP。若输入更大，先按双方最不利图轮流预禁至七张。
    pre_ban_team = "team_a"
    while len(remaining) > 7:
        chosen = (min if pre_ban_team == "team_a" else max)(
            remaining, key=lambda item: item.probability_a
        )
        remove(chosen, "pre_ban", pre_ban_team)
        pre_ban_team = "team_b" if pre_ban_team == "team_a" else "team_a"

    if len(remaining) > required_maps:
        a_ban = min(remaining, key=lambda item: item.probability_a)
        remove(a_ban, "ban", "team_a")
    if len(remaining) > required_maps:
        b_ban = max(remaining, key=lambda item: item.probability_a)
        remove(b_ban, "ban", "team_b")

    ordered: list[MapEstimate] = []
    # BO3: 两张自选 + 第二轮禁图 + 决胜；BO5: 四张选择倾向图 + 决胜。
    need_picks = required_maps - 1
    picker = "team_a"
    while remaining and len(ordered) < need_picks:
        chosen = (max if picker == "team_a" else min)(remaining, key=lambda item: item.probability_a)
        remaining.remove(chosen)
        ordered.append(chosen)
        actions.append({"action": "pick", "team": picker, "map_id": chosen.map_id, "map": MAPS[chosen.map_id]})
        picker = "team_b" if picker == "team_a" else "team_a"
    banner = "team_a"
    while len(remaining) > 1:
        chosen = (min if banner == "team_a" else max)(remaining, key=lambda item: item.probability_a)
        remove(chosen, "ban", banner)
        banner = "team_b" if banner == "team_a" else "team_a"
    if remaining:
        decider = remaining[0]
        ordered.append(decider)
        actions.append({"action": "decider", "team": "none", "map_id": decider.map_id, "map": MAPS[decider.map_id]})
    if len(ordered) < required_maps:
        unused = [item for item in map_estimates if item not in ordered]
        ordered.extend(unused[: required_maps - len(ordered)])

    return {"actions": actions, "ordered_map_ids": [item.map_id for item in ordered[:required_maps]]}


def series_distribution(probabilities_a: list[float], series_format: str) -> dict[str, float]:
    wins_needed = SERIES_FORMATS.get(series_format)
    if wins_needed is None:
        raise ValueError("仅支持 bo3 或 bo5")
    if len(probabilities_a) < wins_needed * 2 - 1:
        raise ValueError("地图概率数量不足以模拟完整系列赛")
    distribution: dict[str, float] = {}

    def walk(index: int, wins_a: int, wins_b: int, probability: float) -> None:
        if wins_a == wins_needed or wins_b == wins_needed:
            key = f"{wins_a}-{wins_b}"
            distribution[key] = distribution.get(key, 0.0) + probability
            return
        p = probabilities_a[index]
        walk(index + 1, wins_a + 1, wins_b, probability * p)
        walk(index + 1, wins_a, wins_b + 1, probability * (1.0 - p))

    walk(0, 0, 0, 1.0)
    return dict(sorted(distribution.items()))
